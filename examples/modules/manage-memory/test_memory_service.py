"""用固定后端验收 CoreMind 的记忆权限、版本及遗忘规则。"""

import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from starlette.testclient import TestClient

from hindsight_backend import HindsightBackend
from memory_server import BankTarget, Bindings, Conflict, MemoryService, Reflection, Target, Write, make_app

TABLE = "资料摘要优先使用表格。"
LIST = "资料摘要优先使用清单。"
QUERY = "资料摘要采用什么格式？"


class HindsightReflectionTest(unittest.IsolatedAsyncioTestCase):
    async def test_related_context_without_direct_evidence_is_not_a_candidate(self):
        backend = HindsightBackend.__new__(HindsightBackend)

        async def reflect(_bank, query, **options):
            self.assertIn("不要根据相近主题生成替代经验", query)
            self.assertIn("hasDirectEvidence", options["response_schema"]["required"])
            return SimpleNamespace(
                based_on=SimpleNamespace(memories=[object()], mental_models=[], directives=[]),
                structured_output={"hasDirectEvidence": False, "rule": "日期使用绝对格式",
                                   "conditions": [], "counterexamples": [], "attribution": [],
                                   "needsConfirmation": ["需要处罚制度原文"]},
                structured_output_error=None,
            )

        backend._client = SimpleNamespace(areflect=reflect)
        self.assertEqual(await backend._reflect("reader-a", "正式处罚金额是多少？", ["format"]), {})


def confirmed(bank="reader-a", text=TABLE, version=0, expires=None):
    return Write(
        bankId=bank,
        documentId="format",
        expectedVersion=version,
        text=text,
        source="session-a:entry-1",
        occurredAt="2020-01-01",
        expiresAt=expires,
    )


class FakeBackend:
    def __init__(self):
        self.data = {}
        self.writes = 0
        self.fail_write = False
        self.fail_delete = False
        self.candidate = {}

    def ensure_bank(self, _bank):
        pass

    def retain(self, bank, doc, text, *, source, version, **_kwargs):
        self.writes += 1
        if self.fail_write:
            raise RuntimeError("后端暂不可用")
        self.data[bank, doc] = {
            "documentId": doc, "text": text, "source": source, "version": version,
        }

    def recall(self, bank, _query, *, allowed_document_ids):
        # 故意保留后端可能返回到期或旧版本的行为，由服务决定能否召回。
        return [item for (scope, _), item in self.data.items() if scope == bank]

    def reflect(self, _bank, _query, *, allowed_document_ids):
        assert allowed_document_ids == ["format"]
        return self.candidate

    def forget(self, bank, doc):
        if self.fail_delete:
            raise RuntimeError("后端暂不可用")
        self.data.pop((bank, doc), None)


class MemoryServiceTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name) / "state.json"
        self.backend = FakeBackend()
        self.service = MemoryService(self.backend, self.state)

    def test_repeated_write_and_conflict(self):
        write = confirmed()
        with ThreadPoolExecutor(max_workers=2) as pool:
            versions = [result["version"] for result in pool.map(self.service.write, [write, write])]
        self.assertEqual(versions, [1, 1])
        self.assertEqual(MemoryService(self.backend, self.state).write(write)["version"], 1)
        self.assertEqual(self.backend.writes, 1)
        with self.assertRaises(Conflict):
            self.service.write(confirmed(text=LIST))
        self.assertEqual(self.backend.writes, 1)

    def test_pending_correction_hides_previous_version_through_restart(self):
        self.service.write(confirmed())
        correction = confirmed(text=LIST, version=1)
        self.backend.fail_write = True
        with self.assertRaisesRegex(RuntimeError, "后端暂不可用"):
            self.service.write(correction)
        self.assertEqual(self.backend.data["reader-a", "format"]["text"], TABLE)
        reopened = MemoryService(self.backend, self.state)
        self.assertEqual(reopened.recall(["reader-a"], QUERY), {"memories": []})
        with self.assertRaises(Conflict):
            reopened.write(confirmed(text="改换格式", version=1))
        self.backend.fail_write = False
        self.assertEqual(reopened.write(correction)["version"], 2)
        result = reopened.recall(["reader-a"], QUERY)["memories"]
        self.assertEqual([(item["text"], item["version"]) for item in result], [(LIST, 2)])

    def test_expiration_filters_even_when_backend_still_has_old_record(self):
        self.service.write(confirmed(expires="2020-01-02"))
        current = datetime(2020, 1, 2, tzinfo=timezone.utc)
        with patch("coremind_memory_mcp.server.datetime") as clock:
            clock.now.return_value = current
            self.assertEqual(self.service.recall(["reader-a"], QUERY), {"memories": []})
        self.assertIn(("reader-a", "format"), self.backend.data)

    def test_forget_can_resume_after_failure_and_rejects_original_write(self):
        original = confirmed()
        self.service.write(original)
        target = Target(bankId=original.bankId, documentId=original.documentId)
        self.backend.fail_delete = True
        with self.assertRaisesRegex(RuntimeError, "后端暂不可用"):
            self.service.forget(target)
        reopened = MemoryService(self.backend, self.state)
        self.assertEqual(reopened.recall(["reader-a"], QUERY), {"memories": []})
        self.backend.fail_delete = False
        self.assertEqual(reopened.forget(target)["status"], "forgotten")
        self.assertNotIn(("reader-a", "format"), self.backend.data)
        again = MemoryService(self.backend, self.state)
        self.assertEqual(again.recall(["reader-a"], QUERY), {"memories": []})
        self.assertEqual(json.loads(self.state.read_text(encoding="utf-8")), {
            "reader-a/format": {"state": "forgotten"},
        })
        with self.assertRaises(Conflict):
            again.write(original)

    def test_reflection_is_only_a_candidate(self):
        self.service.write(confirmed())
        request = Reflection(bankId="reader-a", query="复盘摘要编制")
        self.assertEqual(self.service.reflect(request), {"status": "insufficient_evidence"})
        before = self.state.read_text(encoding="utf-8")
        report = {"structured_output": {"rule": "表格缺少口径时另附说明"},
                  "based_on": {"memories": [{"documentId": "format", "version": 1}]}}
        self.backend.candidate = report
        self.assertEqual(self.service.reflect(request), {"status": "pending", "candidate": report})
        self.assertEqual(self.backend.writes, 1)
        self.assertEqual(self.state.read_text(encoding="utf-8"), before)
        self.assertEqual([m["text"] for m in self.service.recall(["reader-a"], QUERY)["memories"]], [TABLE])
        self.backend.candidate = {**report, "based_on": {"memories": [{"documentId": "format", "version": 9}]}}
        self.assertEqual(self.service.reflect(request), {"status": "insufficient_evidence"})

    def test_bank_forget_is_scope_bound_and_hides_all_documents_on_failure(self):
        original = confirmed()
        self.service.write(original)
        self.service.write(original.model_copy(update={"documentId": "another"}))
        self.service.write(confirmed(bank="reader-b"))
        self.backend.fail_delete = True
        with self.assertRaises(RuntimeError):
            self.service.forget_bank(BankTarget(bankId="reader-a"))
        self.assertEqual(self.service.recall(["reader-a"], QUERY), {"memories": []})
        self.assertEqual(len(self.service.recall(["reader-b"], QUERY)["memories"]), 1)
        self.backend.fail_delete = False
        self.assertEqual(self.service.forget_bank(BankTarget(bankId="reader-a"))["documents"], 2)
        self.assertEqual(list(self.backend.data), [("reader-b", "format")])

    def test_bank_forget_persists_two_full_writes_and_replays_backed_up_deletions(self):
        for number in range(10):
            self.service.write(confirmed().model_copy(update={"documentId": f"doc-{number}"}))
        backup = dict(self.backend.data)
        target = BankTarget(bankId="reader-a")
        with patch.object(self.service, "_save", wraps=self.service._save) as save:
            self.assertEqual(self.service.forget_bank(target)["documents"], 10)
            self.assertEqual(save.call_count, 2)
            for state, call in zip(("forgetting", "forgotten"), save.call_args_list, strict=True):
                self.assertEqual(len(call.args[0]), 10)
                self.assertEqual({receipt["state"] for receipt in call.args[0].values()}, {state})

        self.backend.data = backup
        reopened = MemoryService(self.backend, self.state)
        self.assertEqual(reopened.recall(["reader-a"], QUERY), {"memories": []})
        with patch.object(reopened, "_save", wraps=reopened._save) as save:
            self.assertEqual(reopened.forget_bank(target)["documents"], 10)
            save.assert_not_called()
        self.assertEqual(self.backend.data, {})

    def test_bank_forget_keeps_partial_success_and_unconfirmed_resolution_after_restart(self):
        for doc in ("a", "b", "c"):
            self.service.write(confirmed().model_copy(update={"documentId": doc}))
        self.service.write(confirmed(bank="reader-b", text=LIST))
        target = BankTarget(bankId="reader-a")
        forget = self.backend.forget

        def fail_after_first(bank, doc):
            reopened = MemoryService(self.backend, self.state)
            self.assertEqual(reopened.recall([bank], QUERY), {"memories": []})
            if doc == "b":
                raise RuntimeError("删除暂不可用")
            return forget(bank, doc)

        with patch.object(self.backend, "forget", side_effect=fail_after_first):
            with self.assertRaisesRegex(RuntimeError, "删除暂不可用"):
                self.service.forget_bank(target)

        reopened = MemoryService(self.backend, self.state)
        self.assertEqual(
            [reopened.records[f"reader-a/{doc}"]["state"] for doc in ("a", "b", "c")],
            ["forgotten", "forgetting", "forgetting"],
        )
        self.assertEqual(reopened.recall(["reader-a"], QUERY), {"memories": []})
        self.assertEqual(reopened.forget_bank(target)["documents"], 3)
        self.assertEqual([m["text"] for m in reopened.recall(["reader-b"], QUERY)["memories"]], [LIST])

    def test_bank_forget_can_retry_after_deletion_succeeds_but_receipt_write_fails(self):
        self.service.write(confirmed())
        target = BankTarget(bankId="reader-a")
        persist = self.service._save

        def fail_confirmation(changes):
            if {"state": "forgotten"} in changes.values():
                raise OSError("确认回执未落盘")
            persist(changes)

        with patch.object(self.service, "_save", side_effect=fail_confirmation):
            with self.assertRaisesRegex(OSError, "未落盘"):
                self.service.forget_bank(target)
        self.assertEqual(self.backend.data, {})
        restarted = MemoryService(self.backend, self.state)
        self.assertEqual(restarted.records["reader-a/format"]["state"], "forgetting")
        self.assertEqual(restarted.recall(["reader-a"], QUERY), {"memories": []})
        self.assertEqual(restarted.forget_bank(target)["documents"], 1)
        self.assertEqual(restarted.records["reader-a/format"]["state"], "forgotten")

    def test_reader_and_admin_tokens_are_separate_and_bank_bound(self):
        self.service.write(confirmed())
        self.service.write(confirmed(bank="reader-b", text=LIST))
        bindings = Bindings.model_validate({
            "banks": {"reader-a": {"kind": "personal"}, "reader-b": {"kind": "personal"}},
            "readers": [{"tokenEnv": "TEST_MEMORY_READ", "banks": ["reader-a"]}],
            "administrators": [{"tokenEnv": "TEST_MEMORY_ADMIN", "banks": ["reader-a"]}],
        })
        reader = "Bearer 1234567890-fixture-reader-only"
        admin = "Bearer 0987654321-fixture-admin-only"
        with patch.dict(os.environ, {"TEST_MEMORY_READ": reader, "TEST_MEMORY_ADMIN": admin}):
            app = make_app(self.service, bindings)
        headers = {"Authorization": reader, "Accept": "application/json, text/event-stream"}
        lookup = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {
            "name": "recall_memory", "arguments": {"query": QUERY},
        }}
        with TestClient(app, base_url="http://127.0.0.1:8769") as client:
            self.assertEqual(client.get("/health").status_code, 401)
            self.assertEqual(client.get("/health", headers=headers).status_code, 200)
            self.assertEqual(client.post("/mcp", json=lookup, headers={**headers, "Authorization": admin}).status_code, 401)
            own = {"bankId": "reader-a", "documentId": "format"}
            other = {**own, "bankId": "reader-b"}
            self.assertEqual(client.post("/admin/forget", json=own, headers=headers).status_code, 401)
            forbidden = client.post("/admin/forget", json=other, headers={"Authorization": admin})
            self.assertEqual(forbidden.status_code, 403)
            arrived, release = Event(), Event()
            recall = self.backend.recall

            def slow_recall(*args, **kwargs):
                arrived.set()
                self.assertTrue(release.wait(10))
                return recall(*args, **kwargs)

            with patch.object(self.backend, "recall", side_effect=slow_recall), ThreadPoolExecutor(max_workers=2) as pool:
                pending = pool.submit(client.post, "/mcp", json=lookup, headers=headers)
                try:
                    self.assertTrue(arrived.wait(5))
                    health = pool.submit(client.get, "/health", headers=headers)
                    self.assertEqual(health.result(timeout=3).status_code, 200)
                    self.assertFalse(pending.done())
                finally:
                    release.set()
                response = pending.result(timeout=5)
            self.assertEqual(response.status_code, 200)
            memories = json.loads(response.json()["result"]["content"][0]["text"])["memories"]
            self.assertEqual([(m["bankId"], m["text"]) for m in memories], [("reader-a", TABLE)])


if __name__ == "__main__":
    unittest.main()
