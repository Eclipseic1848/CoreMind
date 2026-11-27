from __future__ import annotations

import json
import asyncio
import sys
import time
import threading
import queue
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from coremind import AsyncCoreMindClient, CoreMindClient, CoreMindError, ProtocolError, WorkerShutdownError
from coremind.client import (
    _validate_checkpoint_result,
    _validate_tool_registration_receipt,
    _validate_tool_result_receipt,
)


def shutdown_client(kind, mode, protocol="1.0"):
    worker = [sys.executable, str(Path(__file__).with_name("fake_worker.py")), mode]
    return kind({"schemaVersion": 2, "name": "shutdown", "agents": {"main": {}}},
                worker_command=worker, protocol_version=protocol)


def assert_worker_released(test, process):
    test.assertIsNotNone(process.poll())
    test.assertTrue(process.stdin.closed)
    test.assertTrue(process.stdout.closed)
    test.assertTrue(process.stderr.closed)


class CoreMindClientTest(unittest.TestCase):
    def test_chat_preserves_explicit_run_id_in_both_protocols(self) -> None:
        for version in ("1.0", "2.0"):
            client = CoreMindClient({"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
                                    protocol_version=version)
            with patch.object(client, "start"), patch.object(client, "_request_raw", return_value={}) as request, \
                 patch("coremind.client._validate_run_result", return_value={}), \
                 patch("coremind.client._validate_run_handle", return_value={}):
                client.chat("hello", run_id="caller-stable-id")
                self.assertEqual(request.call_args.args[1]["runId"], "caller-stable-id")

    def test_python_tool_results_scope_run_only_when_negotiated(self) -> None:
        for scoped in (False, True):
            client = CoreMindClient({"schemaVersion": 2, "name": "demo", "agents": {"main": {}}})
            client._capabilities = frozenset({"scopedToolResults"} if scoped else ())
            client._tools["probe"] = (lambda: "ok", {})
            with patch.object(client, "_request_raw", return_value={}) as request:
                client._execute_python_tool({"runId": "run", "callId": "call", "tool": "probe", "args": {}})
                expected = {"callId": "call", "result": "ok"}
                if scoped:
                    expected["runId"] = "run"
                self.assertEqual(request.call_args.args, ("tool_result", expected))
                client._execute_python_tool({"runId": "run", "callId": "call", "tool": "missing"})
                self.assertEqual("runId" in request.call_args.args[1], scoped)

    def test_event_handler_can_call_client_without_blocking_reader(self) -> None:
        done = threading.Event()
        errors = []
        def callback(event):
            try:
                batch = client.drain_notifications()
                self.assertEqual(set(batch), {"events", "tool_calls", "tool_cancellations", "verification_requests"})
                client.inspect_run("run-1")
            except Exception as error:
                errors.append(error)
            finally:
                done.set()
        with CoreMindClient({"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
                            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
                            event_handler=callback, request_timeout=0.5) as client:
            client.run("回调重入")
            self.assertTrue(done.wait(2))
            self.assertEqual(errors, [])

    def test_slow_callback_overflow_is_visible_and_does_not_block_requests(self) -> None:
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        seen = []
        def callback(event):
            seen.append(event["index"])
            entered.set()
            release.wait(3)
            if len(seen) == 3:
                finished.set()
        with CoreMindClient({"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
                            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
                            event_handler=callback) as client:
            client._event_queue = queue.Queue(maxsize=2)
            client._handle_notification({"method": "event", "params": {"index": 0}})
            self.assertTrue(entered.wait(2))
            try:
                for index in range(1, 5):
                    client._handle_notification({"method": "event", "params": {"index": index}})
                self.assertIsNotNone(client.event_handler_error)
                self.assertEqual(len(client.received_events), 5)
                overflow = client.event_handler_error
                batch = client.drain_notifications()
                self.assertEqual([event["index"] for event in batch["events"]], list(range(5)))
                self.assertEqual(client.received_events, [])
                self.assertIs(client.event_handler_error, overflow)
                client.inspect_run("run-1")
            finally:
                release.set()
            self.assertTrue(finished.wait(2))
            self.assertEqual(seen, [0, 1, 2])

    def test_callback_can_close_client(self) -> None:
        done = threading.Event()
        def callback(event):
            client.close()
            done.set()
        with CoreMindClient({"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
                            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
                            event_handler=callback) as client:
            client._handle_notification({"method": "event", "params": {}})
            self.assertTrue(done.wait(3))
            self.assertFalse(client._reader.is_alive())

    def test_close_reports_worker_failure_after_releasing_resources(self) -> None:
        for mode, reason, code in (
            ("", None, 0),
            ("close-not-quiescent", "not_quiescent", 0),
            ("close-nonzero", "exit_failed", 23),
            ("close-rpc-failed", "rpc_failed", 0),
        ):
            with self.subTest(mode=mode):
                client = shutdown_client(CoreMindClient, mode).start()
                process = client._process
                if reason:
                    with self.assertRaises(WorkerShutdownError) as caught:
                        client.close()
                    self.assertEqual((caught.exception.reason, caught.exception.returncode), (reason, code))
                    if reason == "rpc_failed":
                        self.assertIsInstance(caught.exception.__cause__, ProtocolError)
                else:
                    client.close()
                assert_worker_released(self, process)
                self.assertIsNone(client.close())

    def test_context_manager_does_not_replace_original_exception(self) -> None:
        failure = ValueError("原任务失败")
        with self.assertRaises(ValueError) as caught:
            with shutdown_client(CoreMindClient, "close-not-quiescent") as client:
                process = client._process
                raise failure
        self.assertIs(caught.exception, failure)
        self.assertEqual(failure.coremind_shutdown_error.reason, "not_quiescent")
        assert_worker_released(self, process)

    def test_resume_operation_reuses_unknown_request_and_advances_after_acceptance(self) -> None:
        worker = [sys.executable, str(Path(__file__).with_name("fake_worker.py"))]
        with CoreMindClient({"schemaVersion": 2, "name": "resume-sdk", "agents": {"main": {}}},
                            worker_command=worker, protocol_version="2.0") as client:
            handle = client.run(run_id="resume-sdk")
            client._capabilities |= {"resumeOperations"}
            with patch.object(client, "query", return_value={"derivedFromSequence": 5}) as query:
                with patch.object(client, "_request_raw", side_effect=[CoreMindError("超时"), {}, handle, handle]) as request:
                    with self.assertRaises(CoreMindError):
                        client.resume_run("resume-sdk")
                    with self.assertRaises(ProtocolError):
                        client.resume_run("resume-sdk")
                    client.resume_run("resume-sdk")
                    client.resume_run("resume-sdk")
                    first, malformed, retry, following = [call.args[1] for call in request.call_args_list]
                    self.assertEqual(first, malformed)
                    self.assertEqual(first, retry)
                    self.assertNotEqual(first["resumeOperation"]["operationId"], following["resumeOperation"]["operationId"])
                    self.assertEqual(first["resumeOperation"]["expectedSequence"], 5)
                    self.assertEqual(query.call_count, 2)

    def test_host_verification_requires_capability_and_async_parity(self) -> None:
        worker = [sys.executable, str(Path(__file__).with_name("fake_worker.py"))]
        with CoreMindClient({"schemaVersion": 2, "name": "no-host-verification", "agents": {"main": {}}},
                            worker_command=worker, protocol_version="2.0") as client:
            with self.assertRaises(ProtocolError) as caught:
                client.submit_verification("run-1", "request-1", "a" * 64, decision="accept")
            self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")

        async def verify() -> None:
            async with AsyncCoreMindClient({"schemaVersion": 2, "name": "host-verification", "agents": {"main": {}}},
                                           worker_command=worker, protocol_version="2.0") as client:
                await client.run(run_id="verify-async")
                batch = await client.drain_notifications()
                request = batch["verification_requests"][0]
                self.assertEqual(client.sync_client.received_verification_requests, [])
                receipt = await client.submit_verification(request["runId"], request["requestId"],
                    request["candidateSha256"], decision="accept", control_id="async-verification")
                self.assertEqual(receipt["controlId"], "async-verification")
        asyncio.run(verify())

    def test_host_verification_notification_keeps_only_valid_local_request(self) -> None:
        with CoreMindClient(
            {"schemaVersion": 2, "name": "host-verification", "agents": {"main": {}}},
            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
            protocol_version="2.0",
        ) as client:
            for run_id in ("verify-good", "verify-bad-sha", "verify-bad-id"):
                client.run(run_id=run_id)
            self.assertEqual(len(client.received_verification_requests), 1)
            self.assertEqual(client.received_verification_requests[0]["candidate"], "候选原文")
            self.assertEqual(client.received_events, [])

    def test_host_verification_control_checks_identity_and_capability(self) -> None:
        with CoreMindClient(
            {"schemaVersion": 2, "name": "host-verification", "agents": {"main": {}}},
            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
            protocol_version="2.0",
        ) as client:
            receipt = client.submit_verification("run-1", "request-1", "a" * 64,
                decision="reject", feedback="缺少来源", control_id="control-1")
            self.assertEqual(receipt["controlId"], "control-1")
            self.assertEqual(receipt["status"], "applied")
            for overrides in ({"request_id": ""}, {"candidate_sha256": "bad"},
                              {"decision": "reject", "feedback": " "}):
                args = {"run_id": "run-1", "request_id": "request-1", "candidate_sha256": "a" * 64,
                        "decision": "accept", "feedback": "", **overrides}
                with self.assertRaises(ValueError):
                    client.submit_verification(**args)

    def setUp(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        self.events: list[dict] = []
        self.event_received = threading.Event()
        def on_event(event):
            self.events.append(dict(event))
            self.event_received.set()
        self.client = CoreMindClient(
            {"schemaVersion": 2, "name": "demo", "agents": {"main": {}}},
            worker_command=[sys.executable, str(worker)],
            event_handler=on_event,
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
        self.assertTrue(self.event_received.wait(2))
        self.assertEqual(self.events[0]["event"]["type"], "agent_start")

    def test_event_callback_failure_does_not_stop_protocol_reader(self) -> None:
        def failing_handler(event: object) -> None:
            raise ValueError("不应进入诊断的敏感内容")

        with CoreMindClient(
            {"schemaVersion": 2, "name": "callback-failure", "agents": {"main": {}}},
            worker_command=[sys.executable, str(Path(__file__).with_name("fake_worker.py"))],
            event_handler=failing_handler,
            request_timeout=5,
        ) as client:
            first = client.run("第一次")
            pid = client.pid
            second = client.run("第二次")
            self.assertEqual(first["outcome"]["status"], "succeeded")
            self.assertEqual(second["outcome"]["status"], "succeeded")
            self.assertEqual(client.pid, pid)
            self.assertTrue(client._reader and client._reader.is_alive())
            self.assertTrue(client.received_events)
            deadline = time.monotonic() + 2
            while "event_handler 回调失败：ValueError" not in client._stderr_tail and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertIn("event_handler 回调失败：ValueError", client._stderr_tail)
            self.assertNotIn("敏感内容", "\n".join(client._stderr_tail))

    def test_python_callable_round_trip(self) -> None:
        retained = []
        @self.client.tool(
            description="查询订单",
            effect={"operations": ["read"], "reversible": True},
        )
        def lookup_order(order_id: str) -> dict[str, str]:
            batch = self.client.drain_notifications()
            retained.append(batch)
            self.assertEqual(batch["tool_calls"], [])
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
            batch = client.drain_notifications()
            call = batch["tool_calls"][0]
            self.assertEqual(client.received_tool_calls, [])
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

    def test_approval_failure_sends_one_deny_and_separates_submission_failure(self) -> None:
        def fail(_event):
            raise RuntimeError("不应进入诊断的敏感内容")

        for version in ("1.0", "2.0"):
            for handler, decision in ((fail, "deny"), (lambda _event: "allow", "allow"),
                                      (lambda _event: "deny", "deny")):
                with self.subTest(version=version, handler=handler):
                    client = CoreMindClient({}, protocol_version=version, approval_handler=handler)

                    def reply(method, params):
                        self.assertEqual(method, "approve" if version == "1.0" else "control")
                        self.assertEqual(params["runId"], "run-approval")
                        self.assertEqual(params["approvalId"], "approval-1")
                        self.assertEqual(params["decision"], decision)
                        return {**params, "status": "applied"}

                    with patch.object(client, "_request_raw", side_effect=reply) as request:
                        client._answer_approval({"runId": "run-approval"}, {"approvalId": "approval-1"})
                    request.assert_called_once()
                    self.assertEqual(list(client._stderr_tail),
                                     ["approval_handler 回调失败：RuntimeError"] if handler is fail else [])

        client = CoreMindClient({}, approval_handler=fail)
        with patch.object(client, "_request_raw", side_effect=BrokenPipeError):
            client._answer_approval({"runId": "run-approval"}, {"approvalId": "approval-1"})
        self.assertEqual(list(client._stderr_tail),
                         ["approval_handler 回调失败：RuntimeError", "审批决定提交失败：BrokenPipeError"])
        self.assertEqual(client.approval_handler_error, "approval_handler 回调失败：RuntimeError")
        self.assertEqual(client.approval_submission_error, "审批决定提交失败：BrokenPipeError")

    def test_both_worker_protocols_finish_waiting_when_approval_callback_raises(self) -> None:
        def fail(_event):
            raise RuntimeError("宿主异常")

        for version in ("1.0", "2.0"):
            with self.subTest(version=version):
                client = shutdown_client(CoreMindClient, "approval-roundtrip", version)
                client._approval_handler = fail
                with client:
                    self.assertEqual(client._request_raw("await_fixture_approval", {}, timeout=2),
                                     {"decision": "deny"})
                    self.assertEqual(client.approval_handler_error, "approval_handler 回调失败：RuntimeError")
                    self.assertIsNone(client.approval_submission_error)

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

    def test_protocol_v2_receipts_reject_unknown_fields_and_non_relative_paths(self) -> None:
        checkpoint = {
            "checkpointVersion": 1,
            "checkpointId": "checkpoint-1",
            "runId": "python-v2-run",
            "createdAt": "2026-08-30T00:00:00.000Z",
            "reversible": True,
        }
        for invalid in (
            {**checkpoint, "unknown": True},
            {**checkpoint, "path": "../secret.txt"},
            {**checkpoint, "path": "C:/secret.txt"},
        ):
            with self.subTest(invalid=invalid), self.assertRaises(ProtocolError):
                _validate_checkpoint_result(
                    {
                        "schemaVersion": 1,
                        "action": "list",
                        "runId": "python-v2-run",
                        "derivedFromSequence": 1,
                        "checkpoints": [invalid],
                    },
                    action="list",
                    run_id="python-v2-run",
                )

        definition = {"registrationId": "registration-1", "toolId": "tool-1"}
        with self.assertRaises(ProtocolError):
            _validate_tool_registration_receipt(
                {
                    "schemaVersion": 1,
                    **definition,
                    "definitionFingerprint": f"sha256:{'a' * 64}",
                    "status": "registered",
                    "unknown": True,
                },
                definition,
            )
        request = {
            "resultId": "result-1",
            "runId": "python-v2-run",
            "callId": "call-1",
            "registrationId": "registration-1",
        }
        with self.assertRaises(ProtocolError):
            _validate_tool_result_receipt(
                {"schemaVersion": 1, **request, "status": "accepted", "unknown": True},
                request,
            )

    def test_protocol_v2_checkpoint_list_rejects_schema_drift(self) -> None:
        worker = Path(__file__).with_name("fake_worker.py")
        client = CoreMindClient(
            {"schemaVersion": 2, "name": "checkpoint-validation", "agents": {"main": {}}},
            protocol_version="2.0",
            worker_command=[sys.executable, str(worker)],
            request_timeout=5,
        )
        try:
            for run_id in (
                "checkpoint-sequence-negative",
                "checkpoint-sequence-zero",
                "checkpoint-sequence-bool",
                "checkpoint-empty-id",
                "checkpoint-invalid-time",
                "checkpoint-existing-without-sha",
                "checkpoint-missing-with-sha",
                "checkpoint-missing-with-null-sha",
            ):
                with self.subTest(run_id=run_id), self.assertRaises(ProtocolError):
                    client.checkpoint_list(run_id)
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

    def test_busy_registration_can_retry_and_call_tool_after_run(self) -> None:
        tools = {"operations": ["read"], "reversible": True}
        entered, release = threading.Event(), threading.Event()

        @self.client.tool(name="lookup_order", effect=tools)
        def held_tool(order_id: str) -> str:
            entered.set()
            if not release.wait(5):
                raise RuntimeError("测试未释放首个工具")
            return order_id

        def retry_tool(order_id: str) -> str:
            return f"重试-{order_id}"

        with ThreadPoolExecutor(max_workers=1) as pool:
            original = pool.submit(self.client.run, "调用工具")
            try:
                self.assertTrue(entered.wait(3))
                with self.assertRaises(ProtocolError) as caught:
                    self.client.tool(name="retry_lookup", effect=tools)(retry_tool)
                self.assertEqual(caught.exception.coremind_code, "worker_busy")
            finally:
                release.set()
            self.assertEqual(original.result(timeout=5)["outcome"]["status"], "succeeded")
        self.client.tool(name="retry_lookup", effect=tools)(retry_tool)
        result = self.client.run("调用重试工具")
        self.assertEqual(json.loads(result["transcript"]), "重试-A-1")
        with self.assertRaisesRegex(CoreMindError, "已注册"):
            self.client.tool(name="retry_lookup", effect=tools)(retry_tool)

    def test_registration_with_unknown_delivery_retains_callable_and_marks_outcome(self) -> None:
        self.client.start()
        decorator = self.client.tool(name="lookup_order", effect={"operations": ["read"], "reversible": True})

        def lookup(order_id: str) -> str:
            return order_id

        request = self.client._request_raw

        def response_lost(method, params):
            request(method, params)
            raise CoreMindError("模拟接受注册后断开回执")

        with patch.object(self.client, "_request_raw", side_effect=response_lost):
            with self.assertRaisesRegex(CoreMindError, "断开回执"):
                decorator(lookup)
        with self.assertRaisesRegex(CoreMindError, "远端注册结果未确认"):
            decorator(lookup)
        self.assertEqual(json.loads(self.client.run("调用工具")["transcript"]), "A-1")

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
    async def test_close_checks_v1_receipt_and_v2_exit(self) -> None:
        for protocol, mode, reason in (
            ("1.0", "", None),
            ("2.0", "", None),
            ("1.0", "close-not-quiescent", "not_quiescent"),
            ("1.0", "close-rpc-failed", "rpc_failed"),
            ("2.0", "close-nonzero", "exit_failed"),
        ):
            with self.subTest(protocol=protocol, mode=mode):
                client = await shutdown_client(AsyncCoreMindClient, mode, protocol).start()
                process = client.sync_client._process
                if reason:
                    with self.assertRaises(WorkerShutdownError) as caught:
                        await client.close()
                    self.assertEqual(caught.exception.reason, reason)
                else:
                    await client.close()
                assert_worker_released(self, process)
                self.assertIsNone(await client.close())

    async def test_async_context_manager_keeps_task_exception_and_shutdown_diagnostic(self) -> None:
        failure = ValueError("原异步任务失败")
        with self.assertRaises(ValueError) as caught:
            async with shutdown_client(AsyncCoreMindClient, "close-nonzero", "2.0") as client:
                process = client.sync_client._process
                raise failure
        self.assertIs(caught.exception, failure)
        self.assertEqual(failure.coremind_shutdown_error.returncode, 23)
        assert_worker_released(self, process)

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
