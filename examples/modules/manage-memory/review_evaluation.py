"""通过离线 Hindsight 回放验收多来源经验的复核、重启及旧网关读取。"""

import argparse
import hashlib
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch
from zipfile import ZipFile

from starlette.testclient import TestClient

from effect_evaluation import HindsightReplay
from hindsight_backend import HindsightBackend
from memory_server import Bindings, MemoryService, make_app

BANK = "reader-a"
OTHER = "reader-b"
QUERY = "交接时可采用哪些已经核对的条件？"
RULE = "交接前分别核对封签和温度。"
READ_TOKENS = {bank: f"Bearer coremind-review-fixture-read-{bank}" for bank in (BANK, OTHER)}
ADMIN_TOKENS = {bank: f"Bearer coremind-review-fixture-admin-{bank}" for bank in (BANK, OTHER)}


class StaleReplay(HindsightReplay):
    def __init__(self):
        super().__init__({"direct": True, "rule": RULE, "citations": [
            f"{BANK}/source-a/1", f"{BANK}/source-b/1",
        ]}, [], "交接")
        self.retain_calls = []
        self.forget_calls = []
        self.fail_retain = None
        self.fail_forget = None

    async def aretain(self, bank, text, *, document_id, metadata, **options):
        self.retain_calls.append((bank, document_id, int(metadata["version"])))
        result = await super().aretain(bank, text, document_id=document_id, metadata=metadata, **options)
        if self.fail_retain == (bank, document_id):
            raise RuntimeError("合成写入已完成但回执丢失")
        return result

    async def delete_document(self, bank, document):
        self.forget_calls.append((bank, document))
        if self.fail_forget == (bank, document):
            raise RuntimeError("合成遗忘失败")
        return await super().delete_document(bank, document)

    async def arecall(self, bank, _query, **_options):
        # 旧版本和已遗忘内容仍存在于模拟的恢复快照中，由网关回执遮蔽。
        return SimpleNamespace(results=[
            SimpleNamespace(model_dump=lambda *, mode, row=row: row)
            for key, row in self.rows.items() if key.startswith(f"{bank}/")
        ])


def entry(document, text, *, bank=BANK, version=0, **fields):
    return {"bankId": bank, "documentId": document, "expectedVersion": version,
            "text": text, "source": f"fixture:{bank}:{document}:v{version + 1}",
            "occurredAt": "2020-04-03", "expiresAt": None, "kind": "fact", **fields}


def reference(document, version=1):
    return {"documentId": document, "version": version}


def active(document, version=1):
    return {"status": "active", **reference(document, version)}


def client_for(service, *, legacy=None):
    bindings_type = legacy.Bindings if legacy else Bindings
    bindings = bindings_type.model_validate({
        "banks": {bank: {"kind": "branch"} for bank in (BANK, OTHER)},
        "readers": [{"tokenEnv": f"FIXTURE_READER_{i}", "banks": [bank]}
                    for i, bank in enumerate((BANK, OTHER))],
        "administrators": [] if legacy else [{"tokenEnv": f"FIXTURE_ADMIN_{i}", "banks": [bank]}
                                               for i, bank in enumerate((BANK, OTHER))],
    })
    env = {f"FIXTURE_READER_{i}": READ_TOKENS[bank] for i, bank in enumerate((BANK, OTHER))}
    env.update({f"FIXTURE_ADMIN_{i}": ADMIN_TOKENS[bank] for i, bank in enumerate((BANK, OTHER))})
    with patch.dict(os.environ, env):
        app = (legacy.make_app if legacy else make_app)(service, bindings)
    return TestClient(app, base_url="http://127.0.0.1:8769")


def post(client, operation, request, *, bank=BANK, token=None, status=200):
    response = client.post(f"/admin/{operation}", json=request,
                           headers={"Authorization": token or ADMIN_TOKENS[bank]})
    expected = (status,) if isinstance(status, int) else status
    assert response.status_code in expected, (operation, response.status_code, response.text)
    return response.json()


def recall(client, bank=BANK):
    response = client.post("/mcp", headers={
        "Authorization": READ_TOKENS[bank], "Accept": "application/json, text/event-stream",
    }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
        "name": "recall_memory", "arguments": {"query": QUERY},
    }})
    response.raise_for_status()
    result = json.loads(response.json()["result"]["content"][0]["text"])
    assert all(row["bankId"] == bank for row in result["memories"])
    return {row["documentId"]: row for row in result["memories"]}


def pending(client, bank=BANK):
    result = post(client, "review-status", {"bankId": bank}, bank=bank)
    return {row["documentId"]: row for row in result["pendingReview"]}


def load_legacy(path):
    module = ModuleType("coremind_v200_memory_example")
    member = "coremind-2.0.0-source/examples/modules/manage-memory/memory_server.py"
    with ZipFile(path) as archive:
        exec(compile(archive.read(member), member, "exec"), vars(module))
    return module


def evaluate(state_path, *, legacy=None):
    replay = StaleReplay()
    with patch("coremind_memory_mcp.backend.Hindsight", return_value=replay):
        backend = HindsightBackend("http://127.0.0.1:1")
    try:
        return exercise(state_path, replay, backend, legacy)
    finally:
        backend.close()


def exercise(path, replay, backend, legacy):
    original = entry("historic", "早期宿主确认的手写记录仍有效。", kind="experience")
    legacy_digest = hashlib.sha256(json.dumps(original, sort_keys=True).encode("utf-8")).hexdigest()
    if legacy:
        assert legacy.MemoryService(backend, path).write(legacy.Write.model_validate(original)) == active("historic")
    else:
        path.write_text(json.dumps({f"{BANK}/historic": {
            "state": "active", "version": 1, "digest": legacy_digest, "expiresAt": None,
        }}, ensure_ascii=False), encoding="utf-8")
        backend.retain(BANK, "historic", original["text"],
                       source={"ref": original["source"], "occurredAt": original["occurredAt"]},
                       version=1, kind="experience")

    before = path.read_bytes()
    experience = entry("handover", RULE, kind="experience",
                       evidence=[reference("source-a"), reference("source-b")])
    downstream = entry("checklist", "从已经复核的交接经验生成检查清单。", kind="experience",
                       evidence=[reference("handover")])
    mirror = entry("handover", "另一个读者的交接经验。", bank=OTHER, kind="experience",
                   evidence=[reference("source-a")])
    write_a = entry("source-a", "新交接记录修改了封签检查。", version=1)
    forget_b = {"bankId": BANK, "documentId": "source-b"}
    with client_for(MemoryService(backend, path)) as client:
        assert post(client, "retain", original) == active("historic")
        assert path.read_bytes() == before and len(replay.retain_calls) == 1
        assert recall(client)["historic"]["text"] == original["text"]
        for fact in (entry("source-a", "封签完整。"), entry("source-b", "记录到库温度。"),
                     entry("source-a", "另一个读者的独立封签记录。", bank=OTHER),
                     entry("foreign-only", "另一个读者的私有记录。", bank=OTHER)):
            assert post(client, "retain", fact, bank=fact["bankId"]) == active(fact["documentId"])

        snapshot = path.read_bytes(), replay.retain_calls.copy()
        candidate = post(client, "reflect", {"bankId": BANK, "query": QUERY})
        references = [{key: row[key] for key in ("documentId", "version")}
                      for row in candidate["candidate"]["based_on"]["memories"]]
        assert candidate["status"] == "pending" and references == experience["evidence"]
        assert snapshot == (path.read_bytes(), replay.retain_calls) and "handover" not in recall(client)

        for invalid in ([reference("source-a"), reference("source-a")], [reference("foreign-only")],
                        [reference("source-a", 2)], [reference("handover")]):
            post(client, "retain", {**experience, "evidence": invalid}, status=(400, 409))
        assert snapshot == (path.read_bytes(), replay.retain_calls)
        assert post(client, "retain", experience) == active("handover")
        assert post(client, "retain", downstream) == active("checklist")
        assert post(client, "retain", mirror, bank=OTHER) == active("handover")
        assert recall(client)["handover"]["evidence"] == experience["evidence"]
        assert recall(client, OTHER)["handover"]["text"] == mirror["text"]
        post(client, "review-status", {"bankId": BANK}, token=READ_TOKENS[BANK], status=401)
        post(client, "review-status", {"bankId": OTHER}, status=403)
        snapshot = path.read_bytes(), replay.retain_calls.copy()
        assert post(client, "retain", {**experience, "evidence": list(reversed(experience["evidence"]))}) == active("handover")
        post(client, "correct", {**experience, "expectedVersion": 1, "evidence": [reference("checklist")]},
             status=(400, 409))
        assert snapshot == (path.read_bytes(), replay.retain_calls)

        replay.fail_retain = (BANK, "source-a")
        post(client, "correct", write_a, status=502)
        assert f"{BANK}/source-a/2" in replay.rows
        reviews = pending(client)
        assert reviews == {"handover": {**reference("handover"), "evidence": experience["evidence"]},
                           "checklist": {**reference("checklist"), "evidence": downstream["evidence"]}}
        assert set(recall(client)) == {"historic", "source-b"}
        assert recall(client, OTHER)["handover"]["version"] == 1 and pending(client, OTHER) == {}
        replay.reflect_reply = {"direct": True, "rule": RULE, "citations": [f"{BANK}/handover/1"]}
        assert post(client, "reflect", {"bankId": BANK, "query": QUERY}) == {"status": "insufficient_evidence"}

    review = {**experience, "expectedVersion": 1, "text": "依照最新封签记录和温度记录验交接。",
              "evidence": [reference("source-a", 2), reference("source-b")]}
    rereview = {**downstream, "expectedVersion": 1, "evidence": [reference("handover", 2)]}
    with client_for(MemoryService(backend, path)) as client:
        assert pending(client) == reviews and set(recall(client)) == {"historic", "source-b"}
        snapshot = path.read_bytes(), replay.retain_calls.copy()
        assert post(client, "retain", experience) == {"status": "pending_review", **reference("handover")}
        assert snapshot == (path.read_bytes(), replay.retain_calls)
        replay.fail_retain = None
        assert post(client, "correct", write_a) == active("source-a", 2)
        post(client, "correct", {key: value for key, value in review.items() if key != "evidence"}, status=(400, 409))
        assert post(client, "correct", review) == active("handover", 2)
        assert set(pending(client)) == {"checklist"}
        assert post(client, "correct", rereview) == active("checklist", 2) and pending(client) == {}
        recalled = recall(client)
        assert recalled["source-a"]["version"] == 2 and recalled["handover"]["version"] == 2
        assert recalled["handover"]["evidence"] == review["evidence"]
        replay.fail_forget = (BANK, "source-b")
        post(client, "forget", forget_b, status=502)
        assert set(pending(client)) == {"handover", "checklist"}
        assert set(recall(client)) == {"historic", "source-a"}

    with client_for(MemoryService(backend, path)) as client:
        assert set(pending(client)) == {"handover", "checklist"}
        replay.fail_forget = None
        for _ in range(2):
            assert post(client, "forget", forget_b) == {"status": "forgotten", "documentId": "source-b"}
        assert replay.forget_calls == [(BANK, "source-b")] * 3
        assert set(recall(client)) == {"historic", "source-a"}
        assert recall(client, OTHER)["handover"]["text"] == mirror["text"]
    assert f"{BANK}/source-b/1" in replay.rows
    assert json.loads(path.read_text(encoding="utf-8"))[f"{BANK}/historic"]["digest"] == legacy_digest

    legacy_receipt = None
    if legacy:
        before = path.read_bytes()
        with client_for(legacy.MemoryService(backend, path), legacy=legacy) as client:
            own, other = recall(client), recall(client, OTHER)
            assert set(own) == {"historic", "source-a"} and other["handover"]["text"] == mirror["text"]
            post(client, "forget", forget_b, status=401)
        assert path.read_bytes() == before
        legacy_receipt = {"visible": sorted(own), "otherBankExperience": other["handover"]["version"]}

    # 用独立回执和固定时钟验证来源到期也能阻断旧索引召回。
    expiry = "2090-04-04"
    expiring = entry("short-lived", "本次封签验收临时凭据。", expiresAt=expiry)
    limited = entry("limited-rule", "只采用本次的封签临时凭据。", kind="experience",
                    evidence=[reference("short-lived")])
    expiry_path = path.with_name("expiry.json")
    with patch("coremind_memory_mcp.server.datetime") as clock:
        clock.now.return_value = datetime(2090, 4, 3, tzinfo=timezone.utc)
        with client_for(MemoryService(backend, expiry_path)) as client:
            assert post(client, "retain", expiring) == active("short-lived")
            assert post(client, "retain", limited) == active("limited-rule")
            assert set(recall(client)) == {"short-lived", "limited-rule"}
            clock.now.return_value = datetime(2090, 4, 4, tzinfo=timezone.utc)
            assert recall(client) == {}
    expiry_state = json.loads(expiry_path.read_text(encoding="utf-8"))[f"{BANK}/limited-rule"]
    assert expiry_state["expiresAt"] == expiry

    return {
        "passed": True, "mode": "offline-hindsight-replay", "evidence": experience["evidence"],
        "pendingAfterCorrectionFailure": sorted(reviews), "reconfirmedVersion": 2,
        "pendingAfterForgetReplay": ["checklist", "handover"], "forgetAttempts": len(replay.forget_calls),
        "effectiveExpiry": expiry_state["expiresAt"],
        "historicWriteDigest": legacy_digest, "legacyReadonly": legacy_receipt,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--legacy-archive", type=Path, help="已核验来源的正式 2.0.0 源码 ZIP")
    args = parser.parse_args()
    legacy = load_legacy(args.legacy_archive) if args.legacy_archive else None
    with tempfile.TemporaryDirectory(prefix="coremind-memory-review-") as directory:
        report = evaluate(Path(directory) / "receipts.json", legacy=legacy)
    if args.legacy_archive:
        report["legacyArchiveSha256"] = hashlib.sha256(args.legacy_archive.read_bytes()).hexdigest()
    output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")


if __name__ == "__main__":
    main()
