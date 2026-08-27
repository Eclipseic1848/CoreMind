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
        self.assertTrue(first["childRuns"]["quiescent"])
        self.assertEqual(first["childRuns"]["nodes"][0]["delegationId"], "delegation-1")
        self.assertTrue(first["observability"]["localEnabled"])
        self.assertEqual(first["observability"]["telemetry"]["mode"], "DISABLED")
        self.assertEqual(
            first["observability"]["telemetry"]["deliverySemantics"],
            "best_effort_handoff_not_delivery",
        )
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
        self.assertTrue(inspected["observability"]["localEnabled"])
        self.assertEqual(resumed["runId"], "interrupted-run")
        self.assertTrue(diff["changed"])
        self.assertTrue(restored["restored"])

    def test_protocol_v2_run_handle_events_query_and_control(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "demo-v2", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            handle = client.run("长程任务", run_id="python-v2-run")
            events = client.events("python-v2-run", after_sequence=0, limit=10)
            query = client.query("python-v2-run")
            receipt = client.control(
                {
                    "schemaVersion": 1,
                    "controlId": "cancel-python-v2",
                    "runId": "python-v2-run",
                    "type": "cancel",
                    "reason": "测试取消",
                }
            )

            self.assertEqual(handle["runId"], "python-v2-run")
            self.assertEqual(handle["selectedProtocol"], "2.0")
            self.assertEqual(events["nextCursor"], 1)
            self.assertEqual(query["derivedFromSequence"], 1)
            self.assertEqual(
                query["projection"]["childRuns"]["nodes"][0]["childRunId"],
                "child-1",
            )
            self.assertEqual(receipt["status"], "applied")
        finally:
            client.close()

    def test_protocol_v2_cursor_expired_exposes_recovery_details(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "demo-v2", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            with self.assertRaises(ProtocolError) as captured:
                client.events("expired-run", after_sequence=0)

            self.assertEqual(captured.exception.coremind_code, "cursor_expired")
            self.assertEqual(captured.exception.details["recovery"]["newCursor"], 7)
        finally:
            client.close()

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

    def test_declared_local_observability_rejects_invalid_projection(self) -> None:
        with self.assertRaises(ProtocolError) as captured:
            self.client.run("坏观测")

        self.assertEqual(captured.exception.coremind_code, "invalid_observability")

        with self.assertRaises(ProtocolError) as nested:
            self.client.run("坏观测嵌套")

        self.assertEqual(nested.exception.coremind_code, "invalid_observability")

        for prompt in (
            "坏观测关闭超时",
            "坏观测失败码",
            "坏观测工具阶段",
            "坏观测工具状态",
            "坏观测工具轴",
        ):
            with self.subTest(prompt=prompt), self.assertRaises(ProtocolError) as deep:
                self.client.run(prompt)
            self.assertEqual(deep.exception.coremind_code, "invalid_observability")


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

    async def test_async_adapter_supports_protocol_v2(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = AsyncCoreMindClient(
            {"schemaVersion": 2, "name": "demo-v2", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            handle = await client.run("异步长程任务", run_id="async-v2-run")
            events = await client.events("async-v2-run", after_sequence=0)

            self.assertEqual(handle["selectedProtocol"], "2.0")
            self.assertEqual(events["runId"], "async-v2-run")
        finally:
            await client.close()


if __name__ == "__main__":
    unittest.main()
