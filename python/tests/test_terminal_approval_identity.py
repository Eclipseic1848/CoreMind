from __future__ import annotations

import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import coremind
from coremind import CoreMindClient


CONTENT = "审批身份真实读取正文-739027"


class TerminalApprovalIdentityTest(unittest.TestCase):
    def test_real_default_worker_preserves_two_same_tool_mapping_call_ids(self) -> None:
        for version in ("1.0", "2.0"):
            with self.subTest(version=version):
                self._check(version, workflow=False)

    def test_real_default_worker_preserves_parallel_workflow_step_ids(self) -> None:
        for version in ("1.0", "2.0"):
            with self.subTest(version=version):
                self._check(version, workflow=True)

    def _check(self, version: str, *, workflow: bool) -> None:
        requests, model_errors, approvals, handler_errors, handlers = [], [], [], [], []
        ready, release = threading.Event(), threading.Event()
        lock = threading.Lock()
        test = self

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    finished = any(message.get("role") == "tool" for message in body["messages"])
                    if finished:
                        test.assertIn(CONTENT, json.dumps(body["messages"], ensure_ascii=False))
                        delta = {"role": "assistant", "content": "读取完成"}
                    else:
                        ids = ["same-call"] if workflow else ["call-left", "call-right"]
                        delta = {"role": "assistant", "tool_calls": [{
                            "index": index, "id": call_id, "type": "function",
                            "function": {"name": "read", "arguments": json.dumps({"path": "notes.txt"})},
                        } for index, call_id in enumerate(ids)]}
                    chunks = [{"id": "approval-identity", "choices": [{
                        "index": 0, "delta": change, "finish_reason": reason,
                    }]} for change, reason in ((delta, None), ({}, "stop" if finished else "tool_calls"))]
                    data = ("".join("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n" for chunk in chunks)
                            + "data: [DONE]\n\n").encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    self.wfile.flush()
                except Exception as error:
                    model_errors.append(error)
                    self.send_error(500)

            def log_message(self, *_args):
                pass

        def approve(event):
            with lock:
                approvals.append(dict(event))
                handlers.append(threading.current_thread())
                if len(approvals) == 2:
                    ready.set()
            # 原生批内 beforeToolCall 串行准备；独立 Workflow 分支才同时 held。
            if not workflow:
                return "allow"
            if not release.wait(10):
                handler_errors.append("审批测试未释放")
                return "deny"
            return "allow"

        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        model.daemon_threads = True
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        temporary = None
        client = None
        process = None
        runner = None
        results, run_errors = [], []
        try:
            temporary = tempfile.TemporaryDirectory(prefix="coremind-python-approval-identity-")
            directory = Path(temporary.name)
            (directory / "notes.txt").write_text(CONTENT, encoding="utf-8")
            config = {
                "schemaVersion": 2, "name": "Python 审批身份真实通知",
                "provider": {"id": "approval-probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                             "model": "probe", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                "agents": {"main": {"tools": [{"id": "read"}]}},
                "permissions": {"mode": "ask", "workspaceOnly": True, "network": "deny"},
                "runtime": {"maxTurns": 8, "maxToolCalls": 8, "maxRetries": 0, "runTimeoutMs": 10_000},
            }
            if workflow:
                config["workflow"] = [{"id": "parallel", "type": "parallel", "steps": [
                    {"id": step, "type": "prompt", "agent": "main", "input": step} for step in ("a", "b")
                ]}]
            with patch.dict(os.environ, {"COREMIND_TEST_API_KEY": "offline-test-only"}):
                for name in ("NODE_OPTIONS", "NODE_PATH", "COREMIND_WORKER_PATH"):
                    os.environ.pop(name, None)
                client = CoreMindClient(config, protocol_version=version, config_dir=directory, cwd=directory,
                                        approval_handler=approve, request_timeout=20)
                client.start()
                process = client._process
                self.assertIsNotNone(process)
                self.assertEqual(Path(process.args[1]).resolve(), Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs")

                def run():
                    try:
                        results.append(client.run("读取 notes.txt", run_id="approval-identity"))
                    except BaseException as error:
                        run_errors.append(error)

                runner = threading.Thread(target=run)
                runner.start()
                identity_error = None
                try:
                    self.assertTrue(ready.wait(5), "两项真实审批未同时到达")
                    with lock:
                        captured = list(approvals)
                    self.assertEqual(len(captured), 2)
                    self.assertFalse(release.is_set())
                    self.assertEqual(len({item["approvalId"] for item in captured}), 2)
                    self.assertEqual(len({item["argumentsFingerprint"] for item in captured}), 1)
                    self.assertEqual([item["args"] for item in captured], [{"path": "notes.txt"}] * 2)
                    self.assertTrue(all(item["agent"] == "main" and item["tool"] == "read" for item in captured))
                    self.assertEqual(sorted((item.get("callId") for item in captured), key=str),
                                     ["same-call", "same-call"] if workflow else ["call-left", "call-right"])
                    if workflow:
                        self.assertEqual(sorted((item.get("stepId") for item in captured), key=str), ["a", "b"])
                    else:
                        self.assertTrue(all("stepId" not in item for item in captured))
                except AssertionError as error:
                    identity_error = error
                finally:
                    # 先释放真实审批，再等原 Run；字段缺失不能让红例靠取消或强杀退出。
                    release.set()
                runner.join(timeout=20)
                self.assertFalse(runner.is_alive())
                self.assertEqual(run_errors, [])
                result = results[0]
                if version == "2.0":
                    events = self._finished(client, result["runId"])
                    projection = client.query(result["runId"])["projection"]
                    outcome, trace = projection["outcome"], projection["trace"]
                    required_envelopes = [item for item in events if item["eventType"] == "approval_required"]
                    for item in required_envelopes:
                        for field in ("callId", "stepId"):
                            self.assertEqual(item.get(field), item["payload"].get(field))
                else:
                    outcome, trace = result["outcome"], result["trace"]
                for handler in handlers:
                    handler.join(timeout=2)
                    self.assertFalse(handler.is_alive())
                self.assertEqual(handler_errors, [])
                self.assertEqual(model_errors, [])
                self.assertEqual(outcome["status"], "succeeded", outcome)
                self.assertEqual(len(requests), 4 if workflow else 2)
                if identity_error is not None:
                    raise identity_error
                required = [entry["event"] for entry in trace if entry["event"]["type"] == "approval_required"]
                resolved = [entry["event"] for entry in trace if entry["event"]["type"] == "approval_resolved"]
                self.assertEqual(len(required), 2)
                self.assertEqual(len(resolved), 2)
                for request in approvals:
                    event = next(item for item in required if item["approvalId"] == request["approvalId"])
                    self.assertEqual(event["callId"], request["callId"])
                    self.assertEqual(event.get("stepId"), request.get("stepId"))
                    decision = next(item for item in resolved if item["approvalId"] == request["approvalId"])
                    self.assertEqual(decision["runId"], "approval-identity")
                    self.assertEqual(decision["decision"], "allow")
                    self.assertTrue(all(field not in decision for field in ("callId", "stepId", "agent")))
        finally:
            release.set()
            try:
                if client is not None:
                    if process is not None:
                        with patch.object(process, "terminate", wraps=process.terminate) as terminate, patch.object(process, "kill", wraps=process.kill) as kill:
                            client.close()
                            self.assertEqual(process.returncode, 0)
                            terminate.assert_not_called()
                            kill.assert_not_called()
                        self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))
                        self.assertFalse(client._reader.is_alive())
                        self.assertFalse(client._stderr_reader.is_alive())
                    else:
                        client.close()
            finally:
                try:
                    # 正常业务已在上面 join；失败时也先释放审批并关闭 Worker，再收敛原请求线程。
                    if runner is not None:
                        runner.join(timeout=20)
                        self.assertFalse(runner.is_alive())
                finally:
                    try:
                        model.shutdown()
                    finally:
                        try:
                            model.server_close()
                            model_thread.join(timeout=5)
                            self.assertFalse(model_thread.is_alive())
                        finally:
                            if temporary is not None:
                                temporary.cleanup()

    def _finished(self, client, run_id):
        collected, cursor = [], 0
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            page = client.events(run_id, after_sequence=cursor)
            collected.extend(page["events"])
            cursor = page["nextCursor"]
            if any(event["eventType"] in {"fact.finish", "fact.pause"} for event in page["events"]):
                return collected
            time.sleep(0.02)
        self.fail("审批业务 Run 未形成持久终态")


if __name__ == "__main__":
    unittest.main()
