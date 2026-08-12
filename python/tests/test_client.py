from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError


class CoreMindClientTest(unittest.TestCase):
    def setUp(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        self.events: list[dict] = []
        self.client = CoreMindClient(
            {"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
            worker_command=[sys.executable, str(worker)],
            event_handler=lambda event: self.events.append(dict(event)),
            request_timeout=5,
        )

    def tearDown(self) -> None:
        self.client.close()

    def test_worker_is_persistent_and_result_contract_matches(self) -> None:
        first = self.client.run("第一次")
        pid = self.client.pid
        second = self.client.run("第二次")

        self.assertEqual(first["outcome"]["status"], "succeeded")
        self.assertEqual(first["snapshot"]["outcome"], first["outcome"])
        self.assertEqual(first["snapshot"]["runId"], first["runId"])
        self.assertEqual(second["transcript"], "完成")
        self.assertEqual(self.client.pid, pid)
        self.assertEqual(self.events[0]["event"]["type"], "agent_start")

    def test_python_callable_round_trip(self) -> None:
        @self.client.tool(
            description="查询订单",
            effect={"operations": ["read"], "reversible": True},
        )
        def lookup_order(order_id: str) -> dict[str, str]:
            return {"id": order_id, "status": "paid"}

        result = self.client.run("调用工具")

        self.assertEqual(
            json.loads(result["transcript"]),
            {"id": "A-1", "status": "paid"},
        )

    def test_run_state_and_checkpoint_protocol_methods(self) -> None:
        inspected = self.client.inspect_run("run-1")
        resumed = self.client.resume_run("interrupted-run", input="原始输入")
        diff = self.client.checkpoint_diff("run-1", "checkpoint-1")
        restored = self.client.checkpoint_restore("run-1", "checkpoint-1", confirm=True)

        self.assertEqual(inspected["status"], "finished")
        self.assertEqual(resumed["runId"], "interrupted-run")
        self.assertTrue(diff["changed"])
        self.assertTrue(restored["restored"])

    def test_registration_failure_closes_worker(self) -> None:
        @self.client.tool(
            name="reject_registration",
            description="触发注册失败",
            effect={"operations": ["read"], "reversible": True},
        )
        def rejected_tool() -> str:
            return "x"

        with self.assertRaises(ProtocolError):
            self.client.start()

        self.assertIsNone(self.client.pid)

    def test_inconsistent_snapshot_is_rejected_with_stable_error(self) -> None:
        with self.assertRaises(ProtocolError) as captured:
            self.client.run("坏快照")

        self.assertEqual(captured.exception.coremind_code, "invalid_run_snapshot")


class AsyncCoreMindClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_async_adapter_uses_same_protocol(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = AsyncCoreMindClient(
            {"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            result = await client.run("异步调用")
            self.assertEqual(result["outcome"]["status"], "succeeded")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
