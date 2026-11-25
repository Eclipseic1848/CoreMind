"""装配宿主批准的本体资产、映射和动作处理器。"""

import json
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from threading import Lock

from rdflib import OWL, RDF, RDFS, Literal, URIRef
from rdflib.paths import ZeroOrMore

from ontology_graph import OntologyGraph
from ontology_mapping import map_record


class OntologyProject:
    def __init__(self, directory: Path, executor: Callable[[dict], dict | None] | None = None):
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
            receipt_fields = ("requestId", "resource", "previousState")
            expected = {key: command[key] for key in receipt_fields}
            try:
                receipt = self.executor(dict(command))
            except Exception:
                receipt = None
            result = {**command, "status": "unknown", "reason": "effect_not_confirmed"}
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
            if result["status"] == "unknown":
                self._pending.add(resource)
            self._requests[request_id] = (action, resource, result)
            return dict(result)


def demo_transition(command: dict) -> dict:
    """合成业务处理器。实际项目应返回其事务存储记录的回执。"""
    return {
        "status": "completed",
        "requestId": command["requestId"],
        "resource": command["resource"],
        "previousState": command["previousState"],
        "state": command["expectedState"],
    }
