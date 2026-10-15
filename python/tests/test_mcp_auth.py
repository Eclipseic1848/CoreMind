from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError


FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "mcp-auth-server.mjs"
LAUNCHER = """
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const { startMcpAuthServer } = await import(pathToFileURL(process.argv[1]).href);
const service = await startMcpAuthServer();
process.stdout.write(JSON.stringify({ config: service.config }) + '\\n');
const commands = createInterface({ input: process.stdin });
try {
  for await (const line of commands) {
    const command = JSON.parse(line);
    if (command.action === 'close') break;
    if (command.action === 'complete') {
      const status = await service.completeAuthorization(command.url);
      process.stdout.write(JSON.stringify({ status }) + '\\n');
    } else process.stdout.write(JSON.stringify({ records: service.records }) + '\\n');
  }
} finally { commands.close(); process.stdin.pause(); await service.close(); }
"""


class McpAuthenticationTest(unittest.TestCase):
    def test_sync_default_worker_login_two_runs_and_logout(self) -> None:
        asyncio.run(self._successful(asynchronous=False))

    def test_async_default_worker_login_two_runs_and_logout(self) -> None:
        asyncio.run(self._successful(asynchronous=True))

    async def _successful(self, *, asynchronous: bool) -> None:
        async def execute(invoke, client, fixture):
            caller = threading.get_ident()
            loop = asyncio.get_running_loop()
            callbacks = []

            def sync_handler(request):
                self.assertEqual(threading.get_ident(), caller)
                self.assertIsNot(threading.current_thread(), client._reader)
                callbacks.append(request["transactionId"])
                fixture.command({"action": "complete", "url": request["authorizationUrl"]})

            async def async_handler(request):
                self.assertIs(asyncio.get_running_loop(), loop)
                callbacks.append(request["transactionId"])
                await asyncio.to_thread(fixture.command, {"action": "complete", "url": request["authorizationUrl"]})

            client._mcp_auth_handler = async_handler if asynchronous else sync_handler
            headless = await invoke("run", "读取资源", run_id="before-explicit-login")
            events = await self._finished(invoke, headless["runId"])
            self.assertEqual(events[-1]["payload"]["outcome"]["error"]["code"], "mcp_auth_required")
            self.assertEqual(fixture.command({"action": "inspect"})["records"], [])
            logged = await invoke("mcp_login", "remote", transaction_id="python-explicit-login")
            self.assertEqual(logged["status"], "authorized")
            self.assertEqual(callbacks, ["python-explicit-login"])
            for index in range(2):
                handle = await invoke("run", "读取资源", run_id=f"authorized-{index}")
                events = await self._finished(invoke, handle["runId"])
                outcome = events[-1]["payload"]["outcome"]
                self.assertEqual(outcome["status"], "succeeded", outcome)
                self.assertEqual((await invoke("query", handle["runId"]))["projection"]["outcome"], outcome)
            records = fixture.command({"action": "inspect"})["records"]
            self.assertEqual(len([item for item in records if item["type"] == "token"]), 1)
            self.assertTrue(all(item["authorized"] for item in records if item["type"] == "mcp"))
            self.assertEqual((await invoke("mcp_logout", "remote"))["status"], "logged_out")
            handle = await invoke("run", "读取资源", run_id="after-logout")
            events = await self._finished(invoke, handle["runId"])
            self.assertEqual(events[-1]["payload"]["outcome"]["error"]["code"], "mcp_auth_required")
            self.assertFalse(any("authorizationUrl" in json.dumps(event) for event in client.received_events))
            self.assertNotIn("access-1-", json.dumps({"events": client.received_events, "stderr": list(client._stderr_tail)}))
            self.assertNotIn("refresh-", json.dumps(client.received_events))

        await self._with_client(asynchronous, execute)

    def test_sync_handler_can_cancel_same_node_transaction_without_reader_deadlock(self) -> None:
        async def execute(invoke, client, fixture):
            def handler(request):
                receipt = client.mcp_cancel_auth(request["transactionId"])
                self.assertEqual(receipt["status"], "cancelled")
            client._mcp_auth_handler = handler
            with self.assertRaises(ProtocolError) as caught:
                await invoke("mcp_login", "remote", transaction_id="sync-cancel")
            self.assertEqual(caught.exception.coremind_code, "aborted")
            self.assertFalse(any(item["type"] == "token" for item in fixture.command({"action": "inspect"})["records"]))
        asyncio.run(self._with_client(False, execute))

    def test_async_task_cancel_reaches_node_and_joins_handler(self) -> None:
        async def execute(invoke, client, fixture):
            entered = asyncio.Event()
            released = asyncio.Event()
            async def handler(_request):
                entered.set()
                try:
                    await asyncio.Future()
                finally:
                    released.set()
            client._mcp_auth_handler = handler
            pending = asyncio.create_task(invoke("mcp_login", "remote", transaction_id="async-cancel"))
            await asyncio.wait_for(entered.wait(), 5)
            pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(pending, 7)
            self.assertTrue(released.is_set())
            self.assertEqual((await invoke("mcp_cancel_auth", "async-cancel"))["status"], "not_found")
            self.assertEqual(client._mcp_auth_waiters, {})
            self.assertFalse(any(item["type"] == "token" for item in fixture.command({"action": "inspect"})["records"]))
        asyncio.run(self._with_client(True, execute))

    async def _with_client(self, asynchronous, execute):
        requests = []
        failures = []
        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    finished = any(message.get("role") == "tool" for message in body["messages"])
                    if finished:
                        delta = {"role": "assistant", "content": "完成"}
                    else:
                        tool = next(tool for tool in body["tools"] if tool["function"]["parameters"].get("properties", {}).get("uri"))
                        delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": "authenticated-read", "type": "function", "function": {"name": tool["function"]["name"], "arguments": json.dumps({"uri": "fixture://first"})}}]}
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for content, reason in ((delta, None), ({}, "stop" if finished else "tool_calls")):
                        self.wfile.write(("data: " + json.dumps({"id": "auth-model", "choices": [{"index": 0, "delta": content, "finish_reason": reason}]}) + "\n\n").encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    failures.append(type(error).__name__)
                    self.send_error(500)
            def log_message(self, *_args):
                pass
        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        model.daemon_threads = True
        thread = threading.Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-python-auth-") as directory, _fixture(self) as fixture, patch.dict(os.environ, {"COREMIND_TEST_API_KEY": "offline-test-only"}):
                os.environ.pop("COREMIND_WORKER_PATH", None)
                config = {"schemaVersion": 2, "name": "Python认证验收", "provider": {"id": "probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1", "model": "probe", "apiKeyEnv": "COREMIND_TEST_API_KEY"}, "mcp": {"servers": {"remote": fixture.config}}, "agents": {"main": {"mcpResources": {"remote": ["fixture://first"]}}}, "permissions": {"mode": "full", "network": "allow", "workspaceOnly": True}, "runtime": {"maxRetries": 0, "maxTurns": 3, "runTimeoutMs": 10_000}}
                wrapper = (AsyncCoreMindClient if asynchronous else CoreMindClient)(config, protocol_version="2.0", config_dir=directory, cwd=directory, mcp_auth_handler=lambda _request: None, request_timeout=20)
                client = wrapper.sync_client if asynchronous else wrapper
                async def invoke(method, *args, **kwargs):
                    result = getattr(wrapper, method)(*args, **kwargs)
                    return await result if asynchronous else result
                try:
                    await invoke("start")
                    process = client._process
                    with patch.object(process, "terminate", wraps=process.terminate) as terminate, patch.object(process, "kill", wraps=process.kill) as kill:
                        await execute(invoke, client, fixture)
                        self.assertEqual(failures, [])
                        self.assertIsNone(process.poll())
                        await invoke("close")
                        self.assertEqual(process.returncode, 0)
                        terminate.assert_not_called()
                        kill.assert_not_called()
                    self.assertFalse(any("token" in file.name.lower() for file in Path(directory).rglob("*")))
                finally:
                    await invoke("close")
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())

    async def _finished(self, invoke, run_id):
        collected = []
        cursor = 0
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            page = await invoke("events", run_id, after_sequence=cursor)
            collected.extend(page["events"])
            cursor = page["nextCursor"]
            if any(event["eventType"] in {"fact.finish", "fact.pause"} for event in page["events"]):
                return collected
            await asyncio.sleep(0.02)
        self.fail("认证业务 Run 未完成")


@contextmanager
def _fixture(test):
    process = subprocess.Popen([shutil.which("node"), "--input-type=module", "--eval", LAUNCHER, str(FIXTURE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    responses = queue.Queue(maxsize=16)
    def read():
        for line in process.stdout:
            responses.put(json.loads(line))
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    class Fixture:
        config = None
        def command(self, command):
            process.stdin.write(json.dumps(command) + "\n")
            process.stdin.flush()
            return responses.get(timeout=10)
    try:
        fixture = Fixture()
        fixture.config = responses.get(timeout=10)["config"]
        yield fixture
    finally:
        cleanup_failure = None
        try:
            try:
                if process.poll() is None:
                    process.stdin.write('{"action":"close"}\n')
                    process.stdin.flush()
            except OSError:
                cleanup_failure = "唯一 AS 夹具命令管道提前关闭"
            finally:
                # 关闭命令管道发送真实 EOF；只发 close 而保留写端会让 Node 输入句柄继续存活。
                try:
                    process.stdin.close()
                except OSError:
                    cleanup_failure = "唯一 AS 夹具命令管道关闭失败"
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                cleanup_failure = "唯一 AS 夹具未自然结束，已回收本测试自有进程"
        finally:
            if not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    cleanup_failure = "唯一 AS 夹具命令管道关闭失败"
            reader.join(timeout=2)
            process.stdout.close()
        if cleanup_failure:
            test.fail(cleanup_failure)
        test.assertEqual(process.returncode, 0)
        test.assertFalse(reader.is_alive())


if __name__ == "__main__":
    unittest.main()
