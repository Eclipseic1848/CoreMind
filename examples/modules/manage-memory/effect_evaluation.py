"""用离线 Hindsight 响应与标准 MCP 复跑候选和已确认经验的采用。"""

import json
import os
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from starlette.testclient import TestClient

from hindsight_backend import HindsightBackend
from memory_server import Bindings, MemoryService, Reflection, Target, Write, make_app

FIXTURE = Path(__file__).with_name("effect-cases.json")
READER = "Bearer fixture-memory-reader-0001"


class HindsightReplay:
    def __init__(self, reflect_reply, recall_reply, context):
        self.reflect_reply = reflect_reply
        self.recall_reply = recall_reply
        self.context = context
        self.rows = {}
        self.documents = SimpleNamespace(list_documents=self.list_documents, delete_document=self.delete_document)
        self.memory = SimpleNamespace(get_memory=self.get_memory)

    async def list_documents(self, *_args, **_options):
        return []

    async def aget_bank_config(self, _bank):
        return {"config": {"retain_extraction_mode": "chunks", "enable_observations": False}}

    async def aretain(self, bank, text, *, document_id, metadata, **_options):
        key = f"{bank}/{document_id}/{metadata['version']}"
        self.rows[key] = {"document_id": document_id, "text": text, "metadata": metadata}
        return SimpleNamespace(success=True, var_async=False, items_count=1)

    async def delete_document(self, _bank, _document):
        # 保留回放快照，模拟恢复后仍返回已遗忘的历史记录。
        return SimpleNamespace(success=True)

    async def get_memory(self, _bank, memory_id):
        return self.rows[memory_id]

    async def areflect(self, _bank, _query, **_options):
        reply = self.reflect_reply
        citations = [SimpleNamespace(id=key, document_id=self.rows[key]["document_id"], text=self.rows[key]["text"])
                     for key in reply["citations"]]
        return SimpleNamespace(
            based_on=SimpleNamespace(memories=citations, mental_models=[], directives=[]),
            structured_output={
                "hasDirectEvidence": reply["direct"], "rule": reply["rule"],
                "conditions": [self.context], "counterexamples": ["适用场景不同"],
                "attribution": reply["citations"], "needsConfirmation": ["由业务宿主复核"],
            },
            structured_output_error=None,
        )

    async def arecall(self, _bank, _query, **_options):
        return SimpleNamespace(results=[
            SimpleNamespace(model_dump=lambda *, mode, key=key: self.rows[key])
            for key in self.recall_reply if key in self.rows
        ])

    async def aclose(self):
        pass


def source_key(row):
    return [row["documentId"], row["version"], row["source"]["ref"]]


def run_case(case, documents, state_path):
    replay = HindsightReplay(case["reflectReply"], case["recallReply"], case["context"])
    with patch("coremind_memory_mcp.backend.Hindsight", return_value=replay):
        backend = HindsightBackend("http://127.0.0.1:1")
    try:
        service = MemoryService(backend, state_path)
        for document in documents:
            service.write(Write.model_validate(document))
        for target in case.get("forget", []):
            service.forget(Target.model_validate(target))
        service = MemoryService(backend, state_path)
        before_reflection = state_path.read_bytes(), replay.rows.copy()
        result = service.reflect(Reflection(bankId="reader-a", query=case["question"]))
        reflection_read_only = before_reflection == (state_path.read_bytes(), replay.rows)
        candidate = result.get("candidate", {})
        rule = candidate.get("structured_output", {}).get("rule")
        sources = [source_key(row) for row in candidate.get("based_on", {}).get("memories", [])]

        bindings = Bindings.model_validate({
            "banks": {"reader-a": {"kind": "branch"}},
            "readers": [{"tokenEnv": "COREMIND_EFFECT_FIXTURE_READER", "banks": ["reader-a"]}],
            "administrators": [],
        })
        with patch.dict(os.environ, {"COREMIND_EFFECT_FIXTURE_READER": READER}):
            app = make_app(service, bindings)
        with TestClient(app, base_url="http://127.0.0.1:8769") as client:
            def recall():
                response = client.post("/mcp", headers={
                    "Authorization": READER, "Accept": "application/json, text/event-stream",
                }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
                    "name": "recall_memory", "arguments": {"query": case["question"]},
                }})
                response.raise_for_status()
                return json.loads(response.json()["result"]["content"][0]["text"])["memories"]

            before = recall()
            if case.get("confirm") and result["status"] == "pending":
                service.write(Write(bankId="reader-a", documentId="confirmed-replay", kind="experience",
                                    text=rule, source="+".join(row[2] for row in sources), occurredAt="2020-04-03"))
            memories = recall() if case.get("confirm") else before

        # 此业务夹具只采用当前场景的已确认经验，判分期望在独立字段中。
        prefix = f"用途={case['context']}；"
        adopted = next((row for row in memories if row["kind"] == "experience" and row["text"].startswith(prefix)), None)
        adoption = [*source_key(adopted), adopted["text"]] if adopted else None
        observed = {
            "candidate": {"status": result["status"], "rule": rule, "sources": sources},
            "beforeConfirmation": [source_key(row) for row in before],
            "recall": [source_key(row) for row in memories],
            "adoption": adoption,
            "reflectionReadOnly": reflection_read_only,
        }
        checks = {key: observed[key] == expected for key, expected in case["expect"].items()}
        checks["reflectionReadOnly"] = reflection_read_only
        return {"id": case["id"], "passed": all(checks.values()), "checks": checks, "observed": observed}
    finally:
        backend.close()


def evaluate():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    items = fixture["cases"]
    if not items or len({case["id"] for case in items}) != len(items):
        raise ValueError("记忆评测题集为空或题号重复")
    with tempfile.TemporaryDirectory(prefix="coremind-memory-effects-") as directory:
        cases = [run_case(case, fixture["documents"], Path(directory, f"{i}.json"))
                 for i, case in enumerate(items)]
    return {
        "name": "memory", "mode": "offline", "cases": cases,
        "metrics": {
            "candidateCases": len(cases),
            "candidateFalseAcceptance": sum(not case["checks"]["candidate"]
                                            and case["observed"]["candidate"]["status"] == "pending" for case in cases),
            "candidateMiss": sum(not case["checks"]["candidate"]
                                 and case["observed"]["candidate"]["status"] != "pending" for case in cases),
            "confirmedExperienceWrongAdoption": sum(not case["checks"]["adoption"]
                                                    and case["observed"]["adoption"] is not None for case in cases),
            "confirmedExperienceMiss": sum(not case["checks"]["adoption"]
                                           and case["observed"]["adoption"] is None for case in cases),
        },
    }


if __name__ == "__main__":
    report = evaluate()
    print(json.dumps(report, ensure_ascii=False))
    raise SystemExit(0 if all(case["passed"] for case in report["cases"]) else 1)
