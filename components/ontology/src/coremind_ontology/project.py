"""装配宿主批准的本体资产、映射和动作处理器。"""

import json
import sqlite3
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from threading import Lock

from rdflib import OWL, RDF, RDFS, Literal, URIRef
from rdflib.paths import ZeroOrMore

from .graph import OntologyGraph
from .journal import ActionJournal
from .mapping import map_record


class OntologyProject:
    def __init__(self, directory: Path, executor: Callable[[dict], dict | None] | None = None,
                 *, receipt_db: Path | None = None):
        names = ("model.ttl", "shapes.ttl", "data.ttl", "mapping.json", "actions.json")
        assets = []
        for name in names:
            with (directory / name).open("rb") as asset:
                data = asset.read(256 * 1024 + 1)
            if len(data) > 256 * 1024:
                raise ValueError(f"本体资产超过 256 KiB：{name}")
            assets.append(data)
        model, shapes, data, mapping, actions = (value.decode("utf-8") for value in assets)
        self.graph = OntologyGraph(model, shapes, data)
        self.mapping = json.loads(mapping)
        action_config = json.loads(actions)
        self.version = action_config["modelVersion"]
        self.actions = action_config["actions"]
        if not isinstance(self.version, str) or not self.version or not isinstance(self.actions, dict):
            raise ValueError("动作配置需要本体版本和动作定义")
        for schema in self.mapping["sources"].values():
            if not self._declared(schema["class"], (OWL.Class, RDFS.Class)):
                raise ValueError("映射的目标类未在模型中声明")
            for rule in schema["fields"]:
                if not self._declared(rule["predicate"], (OWL.DatatypeProperty, OWL.ObjectProperty, RDF.Property)):
                    raise ValueError("映射的目标属性未在模型中声明")
        for binding in self.actions.values():
            if (
                not isinstance(binding, dict)
                or set(binding) != {"targetClass", "stateProperty", "from", "to"}
                or not all(isinstance(value, str) and value for value in binding.values())
                or binding["from"] == binding["to"]
            ):
                raise ValueError("动作定义需要目标类、状态属性及不同的前后态")
            if not self._declared(binding["targetClass"], (OWL.Class, RDFS.Class)):
                raise ValueError("动作目标类未在模型中声明")
            if not self._declared(binding["stateProperty"], (OWL.DatatypeProperty, RDF.Property)):
                raise ValueError("动作状态属性未在模型中声明")
        self.identity = {
            "modelVersion": self.version,
            "modelDigest": self.graph.model_digest,
            "bundleDigest": sha256(b"".join(sha256(asset).digest() for asset in assets)).hexdigest(),
        }
        self.executor = executor
        self._lock = Lock()
        self._pending: set[str] = set()
        self._requests: dict[str, tuple[str, str, dict]] = {}
        self._state_conflicts: set[str] = set()
        self._journal = ActionJournal(receipt_db) if receipt_db is not None else None
        if self._journal is not None:
            try:
                self._restore_receipts()
            except BaseException:
                self.close()
                raise

    def close(self):
        if self._journal is not None:
            self._journal.close()

    def _restore_receipts(self):
        transitions = {}
        for result in self._journal.records():
            resource = result["resource"]
            self._requests[result["requestId"]] = (result["action"], resource, result)
            if result["status"] == "unknown":
                self._pending.add(resource)
            elif result["status"] == "completed":
                states, _ = transitions.get((resource, result["stateProperty"]), (set(), None))
                states.update((result["previousState"], result["state"]))
                transitions[resource, result["stateProperty"]] = states, result["state"]
        for (resource, predicate), (states, latest) in transitions.items():
            values = list(self.graph.data.objects(URIRef(resource), URIRef(predicate)))
            if not values and not any(self.graph.data.triples((URIRef(resource), None, None))):
                continue
            if len(values) == 1 and isinstance(values[0], Literal) and str(values[0]) in states:
                self.graph.set_state(resource, predicate, latest)
            else:
                self._state_conflicts.add(resource)

    def _declared(self, iri: str, kinds: tuple[URIRef, ...]) -> bool:
        model = self.graph.model
        return any((URIRef(iri), RDF.type, kind) in model for kind in kinds)

    def describe(self, resource: str) -> dict:
        with self._lock:
            result = self.graph.describe(resource)
            return {**result, **self.identity, "status": "available"}

    def validate_record(self, source: str, record: dict) -> dict:
        mapping, triples = map_record(self.mapping, source, record)
        if mapping["status"] != "mapped":
            return {**self.identity, "status": "needs_confirmation", "mapping": mapping}
        with self._lock:
            return {**self.graph.validate(triples), **self.identity, "mapping": mapping}

    def inspect_action(self, action: str, resource: str) -> dict:
        with self._lock:
            return self._inspect_action(action, resource)

    def _inspect_action(self, action: str, resource: str) -> dict:
        data = self.graph.data
        binding = self.actions.get(action)
        result = {**self.identity, "action": action, "resource": resource}
        if binding is None:
            return {**result, "status": "denied", "reason": "action_not_bound"}
        if resource in self._pending:
            return {**result, "status": "denied", "reason": "prior_effect_unknown"}
        if resource in self._state_conflicts:
            return {**result, "status": "denied", "reason": "model_state_conflict"}
        subject = URIRef(resource)
        target_class = URIRef(binding["targetClass"])
        lineage = RDFS.subClassOf * ZeroOrMore
        if not any(
            (candidate, lineage, target_class) in self.graph.model
            for candidate in data.objects(subject, RDF.type)
        ):
            return {**result, "status": "denied", "reason": "target_not_applicable"}
        state_property = binding["stateProperty"]
        values = list(data.objects(subject, URIRef(state_property)))
        if len(values) != 1 or not isinstance(values[0], Literal):
            return {**result, "status": "denied", "reason": "state_not_established"}
        state = str(values[0])
        if state != binding["from"]:
            return {**result, "status": "denied", "reason": "precondition_failed", "state": state}
        validation = self.graph.validate()
        if validation["status"] == "conforms":
            validation = self.graph.validate_state(resource, state_property, binding["to"])
        if validation["status"] != "conforms":
            status = "unavailable" if validation["status"] == "unavailable" else "denied"
            return {**result, "status": status, "reason": "ontology_validation_failed", "validation": validation}
        return {
            **result,
            "status": "ready",
            "stateProperty": state_property,
            "previousState": state,
            "expectedState": binding["to"],
        }

    def perform_action(self, action: str, resource: str, request_id: str) -> dict:
        if not isinstance(request_id, str) or not request_id.strip() or len(request_id) > 128:
            return {**self.identity, "status": "denied", "reason": "invalid_request_id"}
        with self._lock:
            previous = self._requests.get(request_id)
            if previous is not None:
                if previous[:2] != (action, resource):
                    return {**self.identity, "status": "denied", "reason": "request_id_conflict"}
                return {**previous[2], "replayed": True}
            command = {**self._inspect_action(action, resource), "requestId": request_id}
            if command["status"] != "ready":
                return command
            if self.executor is None:
                return {**command, "status": "unavailable", "reason": "executor_not_bound"}
            unknown = {**command, "status": "unknown", "reason": "effect_not_confirmed"}
            if self._journal is not None:
                try:
                    self._journal.reserve(unknown)
                except sqlite3.Error:
                    return {**command, "status": "unavailable", "reason": "receipt_store_unavailable"}
            self._pending.add(resource)
            self._requests[request_id] = (action, resource, unknown)
            receipt_fields = ("requestId", "resource", "previousState")
            expected = {key: command[key] for key in receipt_fields}
            try:
                receipt = self.executor(dict(command))
            except Exception:
                receipt = None
            result = dict(unknown)
            if isinstance(receipt, dict) and all(receipt.get(key) == value for key, value in expected.items()):
                if receipt.get("status") == "completed" and receipt.get("state") == command["expectedState"]:
                    try:
                        self.graph.set_state(resource, command["stateProperty"], receipt["state"])
                    except Exception:
                        result["reason"] = "effect_projection_failed"
                    else:
                        result = {**command, "status": "completed", "state": receipt["state"]}
                elif receipt.get("status") == "failed" and receipt.get("state") == command["previousState"]:
                    result = {**command, "status": "failed", "state": receipt["state"]}
            if self._journal is not None:
                try:
                    self._journal.finish(result)
                except sqlite3.Error:
                    return dict(unknown)
            if result["status"] != "unknown":
                self._pending.discard(resource)
            self._requests[request_id] = (action, resource, result)
            return dict(result)
