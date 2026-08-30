from __future__ import annotations

import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_protocol_v2_rejects_schema_fingerprint_drift(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "bad-fingerprint", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            with self.assertRaisesRegex(ProtocolError, "Schema 指纹不匹配"):
                client.start()
        finally:
            client.close()

    def test_protocol_v2_checkpoint_and_declaration_only_tool_bridge(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "demo-v2", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            listed = client.checkpoint_list("python-v2-run")
            created = client.checkpoint_create(
                "python-v2-run", "result.txt", operation_id="create-python-1"
            )
            diff = client.checkpoint_diff("python-v2-run", "checkpoint-1")
            restored = client.checkpoint_restore(
                "python-v2-run",
                "checkpoint-1",
                confirm=True,
                operation_id="restore-python-1",
                expected_current=diff["current"],
            )
            registered = client.register_tool_definition(
                {
                    "schemaVersion": 1,
                    "registrationId": "registration-python-1",
                    "definitionVersion": 1,
                    "toolId": "lookup-record",
                    "name": "lookup_record",
                    "description": "读取一条记录",
                    "parameters": {"type": "object"},
                    "effect": {"operations": ["read"], "reversible": True},
                    "capability": {
                        "effect": "none",
                        "replay": "safe",
                        "concurrency": "parallel",
                        "checkpoint": "none",
                        "durability": "ordinary",
                    },
                }
            )
            for _ in range(100):
                if client.received_tool_calls:
                    break
                time.sleep(0.01)
            call = client.received_tool_calls[0]
            receipt = client.submit_tool_result(
                call["runId"],
                call["callId"],
                call["registrationId"],
                result={"value": 42},
                result_id="result-python-1",
            )

            self.assertEqual(listed["checkpoints"][0]["path"], "result.txt")
            self.assertNotIn("snapshotFile", json.dumps(listed))
            self.assertEqual(created["status"], "applied")
            self.assertEqual(restored["status"], "applied")
            self.assertEqual(registered["status"], "registered")
            self.assertEqual(call["toolId"], "lookup-record")
            self.assertEqual(receipt["status"], "accepted")
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

    def test_protocol_v2_answers_approval_with_control(self) -> None:
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "approval-v2", "agents": {"main": {}}},
            protocol_version="2.0",
            approval_handler=lambda _event: "allow",
        )
        approval_id = "approval-python-v2"
        command = {
            "schemaVersion": 1,
            "controlId": "19f7682c0637eab457591784742b05adb30be7e67e51049c4e4a49f598efc2cf",
            "runId": "python-v2-run",
            "type": "approval",
            "approvalId": approval_id,
            "decision": "allow",
        }
        with patch.object(
            client,
            "_request_raw",
            return_value={**command, "status": "applied"},
        ) as request:
            client._answer_approval({"runId": "python-v2-run"}, {"approvalId": approval_id})

        request.assert_called_once_with("control", command)

    def test_protocol_v2_rejects_invalid_tool_call_id(self) -> None:
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "tool-call-v2", "agents": {"main": {}}},
            protocol_version="2.0",
        )
        client._handle_notification(
            {
                "jsonrpc": "2.0",
                "protocolVersion": "2.0",
                "method": "tool_call",
                "params": {
                    "schemaVersion": 1,
                    "runId": "python-v2-run",
                    "callId": " \t",
                    "registrationId": "registration-1",
                    "toolId": "lookup-record",
                    "name": "lookup_record",
                    "argumentsFingerprint": f"sha256:{'a' * 64}",
                    "args": {"id": "42"},
                },
            }
        )

        self.assertEqual(client.received_tool_calls, [])
        self.assertIn("ToolCall 非法", client._stderr_tail[-1])

    def test_protocol_v2_rejects_unknown_tool_call_fields_and_records_cancel(self) -> None:
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "tool-call-v2", "agents": {"main": {}}},
            protocol_version="2.0",
        )
        params = {
            "schemaVersion": 1,
            "runId": "python-v2-run",
            "callId": "call-1",
            "registrationId": "registration-1",
            "toolId": "lookup-record",
            "name": "lookup_record",
            "argumentsFingerprint": f"sha256:{'a' * 64}",
            "args": {"id": "42"},
        }
        client._handle_notification(
            {
                "jsonrpc": "2.0",
                "protocolVersion": "2.0",
                "method": "tool_call",
                "params": {**params, "unknown": True},
            }
        )
        client._handle_notification(
            {
                "jsonrpc": "2.0",
                "protocolVersion": "2.0",
                "method": "tool_cancel",
                "params": {
                    "schemaVersion": 1,
                    "runId": "python-v2-run",
                    "callId": "call-1",
                    "registrationId": "registration-1",
                    "toolId": "lookup-record",
                    "reason": "aborted",
                },
            }
        )

        self.assertEqual(client.received_tool_calls, [])
        self.assertIn("ToolCall 非法", client._stderr_tail[-1])
        self.assertEqual(client.received_tool_cancellations[0]["callId"], "call-1")

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

    def test_custom_worker_unknown_code_fails_closed(self) -> None:
        with self.assertRaises(ProtocolError) as captured:
            self.client.run("未知错误码")

        error = captured.exception
        self.assertEqual(error.coremind_code, "unclassified_error")
        self.assertEqual(error.original_coremind_code, "vendor_private_error")
        self.assertEqual(error.error_info["humanAction"], "required")
        self.assertEqual(error.error_info["retryClass"], "human")
        self.assertEqual(error.error_info["runStatus"], "paused")
        self.assertEqual(error.details, {"source": "synthetic-custom-worker"})

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
