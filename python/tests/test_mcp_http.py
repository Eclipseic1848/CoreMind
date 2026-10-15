from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import coremind
from coremind import AsyncCoreMindClient, CoreMindClient


FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "mcp-http-server.mjs"
SECRET = "python-http-mcp-private-739027"
URI = "fixture://first"
BUSINESS_ARGS = {"value": {"flag": False, "count": 0, "empty": None}}


def service_records(file: Path) -> list[dict]:
    if not file.exists():
        return []
    # 夹具仍在追加时只读取完整行，避免把写到一半的观察误报为协议错误。
    return [json.loads(line) for line in file.read_text(encoding="utf-8").split("\n")[:-1] if line]


class McpHttpTest(unittest.TestCase):
    def test_sync_bundled_worker_allows_and_denies_http_resource(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=False, denied=denied))

    def test_async_bundled_worker_allows_and_denies_http_resource(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=True, denied=denied))

    def test_sync_bundled_worker_cancels_sent_http_call_with_query_and_events(self) -> None:
        asyncio.run(self._check(asynchronous=False, denied=False, cancelled=True))

    def test_async_bundled_worker_cancels_sent_http_call_with_query_and_events(self) -> None:
        asyncio.run(self._check(asynchronous=True, denied=False, cancelled=True))

    async def _check(self, *, asynchronous: bool, denied: bool, cancelled: bool = False) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        self.assertTrue(FIXTURE.is_file(), "测试需要真实 HTTP MCP 夹具")
        requests: list[dict] = []
        errors: list[Exception] = []
        read_tool_name = ""
        test = self

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                nonlocal read_tool_name
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    if len(requests) == 1:
                        if cancelled:
                            test.assertEqual(len(request["tools"]), 1)
                            selected = request["tools"]
                        else:
                            test.assertEqual([record for record in service_records(record_file)
                                              if record.get("type") == "http"], [])
                            test.assertEqual([record for record in service_records(record_file)
                                              if record.get("type") == "socket-open"], [])
                            test.assertEqual(len(request["tools"]), 3)
                            selected = [tool for tool in request["tools"] if
                                        tool["function"]["parameters"].get("properties", {})
                                        .get("uri", {}).get("enum") == [URI]]
                        test.assertEqual(len(selected), 1)
                        read_tool_name = selected[0]["function"]["name"]
                        delta = {"role": "assistant", "tool_calls": [{
                            "index": 0, "id": "python-http-read", "type": "function",
                            "function": {"name": read_tool_name,
                                         "arguments": json.dumps(BUSINESS_ARGS if cancelled else {"uri": URI})},
                        }]}
                        reason = "tool_calls"
                    else:
                        test.assertEqual(len(requests), 2)
                        test.assertIn("资源正文 false 0 null", json.dumps(request["messages"], ensure_ascii=False))
                        delta = {"role": "assistant", "content": "HTTP 资源读取完成"}
                        reason = "stop"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for content, finish in ((delta, None), ({}, reason)):
                        chunk = {"id": f"python-http-{len(requests)}", "choices": [{
                            "index": 0, "delta": content, "finish_reason": finish,
                        }]}
                        self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    errors.append(error)
                    if not self.wfile.closed:
                        self.send_error(500)

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        model.daemon_threads = True
        server_thread = Thread(target=model.serve_forever, daemon=True)
        server_thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-python-http-mcp-") as directory, \
                    patch.dict(os.environ, {
                        "COREMIND_TEST_API_KEY": "offline-test-only",
                        "MCP_TEST_SECRET": f"Bearer {SECRET}",
                    }):
                os.environ.pop("COREMIND_WORKER_PATH", None)
                workspace = Path(directory)
                record_file = workspace / "service.jsonl"
                with (workspace / "fixture.stdout").open("w", encoding="utf-8") as stdout, \
                        (workspace / "fixture.stderr").open("w", encoding="utf-8") as stderr:
                    fixture = subprocess.Popen(
                        [node, str(FIXTURE), str(record_file), "hang-call" if cancelled else "normal"],
                        stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                        text=True, encoding="utf-8", env={**os.environ, "MCP_TEST_SECRET": SECRET},
                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    try:
                        deadline = time.monotonic() + 10
                        started = None
                        while started is None:
                            self.assertIsNone(fixture.poll(), "HTTP 夹具未正常启动")
                            self.assertLess(time.monotonic(), deadline, "HTTP 夹具启动超时")
                            started = next((record for record in service_records(record_file)
                                            if record.get("type") == "started"), None)
                            if started is None:
                                await asyncio.sleep(0.02)
                        config = {
                            "schemaVersion": 2, "name": "Python HTTP MCP 资源真实验收",
                            "provider": {"id": "probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                         "model": "probe-model", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                            "mcp": {"servers": {"remote": {
                                "transport": "streamable-http", "url": started["url"],
                                "allowedAddresses": ["127.0.0.1"],
                                "headers": {"Authorization": {"env": "MCP_TEST_SECRET"}},
                            }}},
                            "agents": {"main": {"mcpResources": {"remote": [URI]}}},
                            "permissions": {"mode": "full", "workspaceOnly": True,
                                            "network": "deny" if denied else "allow"},
                            "runtime": {"maxTurns": 3, "maxRetries": 0, "maxToolCalls": 3, "runTimeoutMs": 15_000},
                        }
                        if cancelled:
                            config["agents"] = {"main": {"tools": [{
                                "mcp": {"server": "remote", "tool": "echo"},
                                "effect": {"operations": ["network"], "reversible": False},
                                "capability": {"effect": "network", "replay": "unknown",
                                               "concurrency": "run_serial", "checkpoint": "none",
                                               "durability": "critical"},
                            }]}}
                        client = (AsyncCoreMindClient if asynchronous else CoreMindClient)(
                            config, protocol_version="2.0", config_dir=workspace, cwd=workspace,
                            request_timeout=25,
                        )

                        async def invoke(method: str, *args, **kwargs):
                            result = getattr(client, method)(*args, **kwargs)
                            return await result if asynchronous else result

                        try:
                            await invoke("start")
                            sync_client = client.sync_client if asynchronous else client
                            process = sync_client._process
                            self.assertIsNotNone(process)
                            bundled = Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs"
                            self.assertEqual(Path(process.args[1]).resolve(), bundled)
                            with patch.object(process, "terminate", wraps=process.terminate) as terminate, \
                                    patch.object(process, "kill", wraps=process.kill) as kill:
                                mode = "cancel" if cancelled else "deny" if denied else "allow"
                                run_id = f"python-http-{'async' if asynchronous else 'sync'}-{mode}"
                                handle = await invoke("run", "读取已授权资源", run_id=run_id)
                                self.assertEqual((handle["runId"], handle["selectedProtocol"]), (run_id, "2.0"))
                                if cancelled:
                                    deadline = time.monotonic() + 10
                                    while not any(record.get("type") == "request" and record.get("method") == "tools/call"
                                                  for record in service_records(record_file)):
                                        self.assertLess(time.monotonic(), deadline, "HTTP 业务请求尚未实际发送")
                                        self.assertIsNone(process.poll())
                                        await asyncio.sleep(0.02)
                                    await invoke("cancel", run_id)
                                events = await self._read_finished(invoke, run_id)
                                outcome = events[-1]["payload"]["outcome"]
                                expected_status = "aborted" if cancelled else "paused" if denied else "succeeded"
                                self.assertEqual(outcome["status"], expected_status, outcome)
                                if denied:
                                    self.assertEqual(outcome["finishReason"], "tool_approval_denied")
                                if cancelled:
                                    self.assertEqual(outcome["finishReason"], "aborted")
                                projection = (await invoke("query", run_id))["projection"]
                                self.assertEqual(projection["outcome"], outcome)
                                self.assertEqual(len(requests), 1 if denied or cancelled else 2)
                                receipts = [event["payload"] for event in events
                                            if event["eventType"] == "effect_receipt"
                                            and event["payload"].get("tool") == read_tool_name]
                                receipt_status = "unknown" if cancelled else "not_started" if denied else "committed"
                                self.assertIn(receipt_status,
                                              [receipt["status"] for receipt in receipts])
                                if cancelled:
                                    calls = [event["payload"] for event in events if event["eventType"] == "tool_call"
                                             and event["payload"].get("tool") == read_tool_name]
                                    self.assertEqual(len(calls), 1)
                                    self.assertEqual({receipt["callId"] for receipt in receipts}, {calls[0]["callId"]})
                                    self.assertEqual([receipt["status"] for receipt in receipts], ["started", "unknown"])
                                records = service_records(record_file)
                                if denied:
                                    self.assertEqual([record for record in records if record.get("type") == "http"], [])
                                    self.assertEqual([record for record in records if record.get("type") == "socket-open"], [])
                                    self.assertFalse(any(receipt["status"] in {"started", "unknown"} for receipt in receipts))
                                else:
                                    calls = [record for record in records if record.get("type") == "request"]
                                    self.assertEqual(len([record for record in calls if record["method"] == "initialize"]), 1)
                                    reads = [record for record in calls if record["method"] == (
                                        "tools/call" if cancelled else "resources/read")]
                                    self.assertEqual(len(reads), 1)
                                    self.assertEqual(reads[0]["params"], {"name": "echo", "arguments": BUSINESS_ARGS}
                                                     if cancelled else {"uri": URI})
                                    self.assertFalse(any(record["method"] in {
                                        "resources/list", "resources/templates/list",
                                    } for record in calls))
                                    self.assertEqual(len([record for record in calls if record["method"] == "tools/list"]),
                                                     1 if cancelled else 0)
                                    http = [record for record in records if record.get("type") == "http"]
                                    self.assertTrue(http)
                                    self.assertTrue(all(record["authorizationMatched"] for record in http))
                                self.assertEqual(any(event["eventType"] == "policy_denied" for event in events), denied)
                                self.assertFalse(any(event["eventType"] == "quiescence_timeout" for event in events))
                                deadline = time.monotonic() + 3
                                while True:
                                    records = service_records(record_file)
                                    opened = sum(record.get("type") == "socket-open" for record in records)
                                    closed = sum(record.get("type") == "socket-closed" for record in records)
                                    if opened == closed:
                                        break
                                    self.assertLess(time.monotonic(), deadline, "Run 终态后 HTTP socket 未关闭")
                                    await asyncio.sleep(0.02)
                                self.assertIsNone(process.poll(), "HTTP 关闭不能依赖退出整个 Worker")
                                facts = [file.read_text(encoding="utf-8") for file in workspace.rglob("*.jsonl")
                                         if file != record_file]
                                self.assertTrue(facts, "应有真实持久 Run Facts")
                                persisted = [json.loads(line) for body in facts for line in body.splitlines() if line]
                                persisted_receipts = [record["payload"]["event"] for record in persisted
                                                      if record.get("kind") == "event"
                                                      and record.get("payload", {}).get("event", {}).get("type") == "effect_receipt"
                                                      and record["payload"]["event"].get("tool") == read_tool_name]
                                self.assertIn(receipt_status,
                                              [receipt["status"] for receipt in persisted_receipts])
                                if cancelled:
                                    run_records = [record for record in persisted if record.get("runId") == run_id]
                                    trace = [record["payload"] for record in run_records if record.get("kind") == "event"]
                                    self.assertEqual(projection["status"], "finished")
                                    self.assertEqual(projection["records"], run_records)
                                    self.assertEqual(projection["trace"], trace)
                                    self.assertEqual(projection["snapshot"]["outcome"], outcome)
                                    self.assertEqual(projection["snapshot"]["trace"], trace)
                                    self.assertEqual([event["payload"] for event in events
                                                      if not event["eventType"].startswith("fact.")],
                                                     [entry["event"] for entry in trace])
                                    self.assertEqual([receipt["status"] for receipt in persisted_receipts],
                                                     ["started", "unknown"])
                                    self.assertEqual(len([record for record in service_records(record_file)
                                                         if record.get("type") == "request"
                                                         and record.get("method") == "tools/call"]), 1)
                                self.assertNotIn(SECRET, json.dumps({
                                    "requests": requests, "events": events, "projection": projection,
                                    "facts": facts, "notifications": sync_client.received_events,
                                    "errors": [str(error) for error in errors], "stderr": list(sync_client._stderr_tail),
                                }, ensure_ascii=False))
                                self.assertEqual(errors, [])
                                await invoke("close")
                                self.assertEqual(process.returncode, 0)
                                self.assertTrue(process.stdin.closed)
                                terminate.assert_not_called()
                                kill.assert_not_called()
                        finally:
                            await invoke("close")
                    finally:
                        if fixture.poll() is None:
                            fixture.terminate()
                        try:
                            fixture.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            fixture.kill()
                            fixture.wait(timeout=5)
                            self.fail("HTTP 夹具未及时退出，已清理本测试自有进程")
        finally:
            model.shutdown()
            model.server_close()
            server_thread.join(timeout=5)
            self.assertFalse(server_thread.is_alive())

    async def _read_finished(self, invoke, run_id: str) -> list[dict]:
        events: list[dict] = []
        cursor = 0
        deadline = time.monotonic() + 25
        while True:
            page = await invoke("events", run_id, after_sequence=cursor, limit=100)
            events.extend(page["events"])
            cursor = page["nextCursor"]
            self.assertLess(time.monotonic(), deadline, "HTTP 资源 Run 未形成持久终态")
            if any(event["eventType"] in {"fact.finish", "fact.pause"} for event in page["events"]):
                self.assertEqual([event["sequence"] for event in events], list(range(1, cursor + 1)))
                return events
            await asyncio.sleep(0.02)


if __name__ == "__main__":
    unittest.main()
