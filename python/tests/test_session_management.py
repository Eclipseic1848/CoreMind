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

from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError
from coremind.errors import WorkerExitedError
from coremind._session_management import validate_management_error, validate_management_result

ROOT = Path(__file__).resolve().parents[2]
HOST = ROOT / "test/fixtures/task-session-host.mjs"
NODE = shutil.which("node")


def configuration(base_url="http://127.0.0.1:1/v1"):
    return {"schemaVersion": 2, "name": "跨语言任务验收", "defaultAgent": "main",
            "provider": {"id": "task-test", "model": "offline", "baseUrl": base_url,
                         "apiKeyEnv": "COREMIND_TASK_TEST_KEY"},
            "agents": {"main": {}}, "runtime": {"maxRetries": 0, "runTimeoutMs": 10_000},
            "permissions": {"mode": "ask", "network": "allow", "workspaceOnly": False}}


class SessionManagementTest(unittest.TestCase):
    def test_sync_real_worker_crash_restart_calls_wake_cancel_and_ts_parity(self):
        asyncio.run(self._lifecycle(False))

    def test_async_real_worker_crash_restart_calls_wake_cancel_and_ts_parity(self):
        asyncio.run(self._lifecycle(True))

    def _ts(self, workspace, config, *commands):
        payload = workspace / "ts-commands.json"
        payload.write_text(json.dumps({"workspace": str(workspace), "config": config,
                                       "commands": commands}, ensure_ascii=False), encoding="utf-8")
        process = subprocess.run([NODE, str(ROOT / "test/fixtures/task-session-client.mjs"), str(payload)],
                                 capture_output=True, text=True, encoding="utf-8", timeout=30, cwd=ROOT)
        self.assertEqual(process.returncode, 0, process.stderr)
        return json.loads(process.stdout)

    async def _lifecycle(self, asynchronous):
        self.assertIsNotNone(NODE)
        with tempfile.TemporaryDirectory(prefix="coremind-task-bridge-") as directory, \
                patch.dict(os.environ, {"COREMIND_TASK_TEST_KEY": "offline-test-only"}):
            workspace, config = Path(directory), configuration()
            kind = AsyncCoreMindClient if asynchronous else CoreMindClient
            def open_client():
                return kind(config, protocol_version="2.0", config_dir=workspace, cwd=workspace,
                            session_id="shared", worker_command=[NODE, str(HOST), str(workspace)],
                            request_timeout=10)
            async def call(client, name, *args):
                operation = getattr(client, name)
                return await operation(*args) if asynchronous else await asyncio.to_thread(operation, *args)
            def command(action, **fields):
                return {"method": "task", "command": {"action": action, **fields}}
            client = open_client()
            try:
                started = await call(client, "task_start", "job", "counter", "initial")
                self.assertEqual(started["task"]["status"], "ready")
                process = (client.sync_client if asynchronous else client)._process
                with self.assertRaises(WorkerExitedError):
                    await call(client, "task_resume", "job")
                self.assertEqual(process.wait(timeout=5), 23)
            finally:
                await call(client, "close")
            before, saved, resumed, after = self._ts(
                workspace, config, command("query", taskId="job"), command("calls", taskId="job"),
                command("resume", taskId="job"), command("calls", taskId="job"))
            self.assertEqual(before["task"]["checkpoint"], "initial")
            self.assertEqual(saved, after)
            self.assertEqual(len(saved["calls"]), 1)
            self.assertEqual(saved["calls"][0]["status"], "completed")
            self.assertEqual(saved["calls"][0]["result"]["details"], {"value": 42})
            self.assertEqual(resumed["task"]["status"], "sleeping")
            self.assertEqual(resumed["task"]["checkpoint"], "已保存🙂")
            self.assertEqual(len((workspace / "effects.txt").read_text(encoding="utf-8").splitlines()), 1)
            client = open_client()
            try:
                self.assertEqual((await call(client, "task_query", "job"))["task"], resumed["task"])
                self.assertEqual(await call(client, "task_calls", "job"), saved)
                deadline = (await call(client, "task_next_wake"))["deadline"]
                self.assertEqual(deadline["taskId"], "job")
                self.assertEqual(deadline["remainingMs"], 0)
                self.assertEqual((await call(client, "task_wake", "job", "wake-1", deadline["sleepId"]))["wakeStatus"], "accepted")
            finally:
                await call(client, "close")
            repeated, done = self._ts(workspace, config,
                command("wake", taskId="job", wakeId="wake-1", sleepId=deadline["sleepId"]),
                command("resume", taskId="job"))
            self.assertEqual(repeated["wakeStatus"], "duplicate")
            self.assertEqual(done["task"]["status"], "completed")
            client = open_client()
            try:
                self.assertEqual((await call(client, "task_query", "job"))["task"], done["task"])
                self.assertEqual(await call(client, "task_calls", "job"), saved)
                self.assertIsNone((await call(client, "task_next_wake"))["deadline"])
                # 未来时间是业务数据；不延长或等待超时来验证 not_due。
                await call(client, "task_start", "future", "wait", 8_000_000_000_000)
                waiting = (await call(client, "task_resume", "future"))["task"]
                early = await call(client, "task_wake", "future", "early", waiting["sleep"]["sleepId"])
                self.assertEqual(early["wakeStatus"], "not_due")
                self.assertEqual((await call(client, "task_cancel", "future"))["task"]["status"], "cancelled")
                await call(client, "task_start", "blocking", "blocking", None)
                running = asyncio.create_task(call(client, "task_resume", "blocking"))
                limit = time.monotonic() + 5
                while not (workspace / "entered.txt").exists():
                    self.assertLess(time.monotonic(), limit, "真实阶段未在5秒内进入")
                    await asyncio.sleep(0.01)
                with self.assertRaises(ProtocolError) as busy:
                    await call(client, "task_resume", "blocking")
                self.assertEqual(busy.exception.coremind_code, "worker_busy")
                self.assertEqual(busy.exception.details["taskId"], "blocking")
                self.assertEqual((await call(client, "task_cancel", "blocking"))["task"]["status"], "cancelled")
                with self.assertRaises(ProtocolError) as cancelled:
                    await running
                self.assertEqual(cancelled.exception.details["taskCode"], "task_cancelled")
                with self.assertRaises(ProtocolError) as missing:
                    await call(client, "task_start", "missing", "unknown", None)
                error = missing.exception
                with self.assertRaises(ProtocolError) as invalid:
                    await call(client, "task_start", "../bad", "wait", 0)
                self.assertEqual(invalid.exception.coremind_code, "protocol_validation_failed")
            finally:
                await call(client, "close")
            [ts_error] = self._ts(workspace, config, command("start", taskId="missing", type="unknown", checkpoint=None))
            self.assertEqual(ts_error["error"]["coremindCode"], error.coremind_code)
            self.assertEqual(ts_error["error"]["details"], error.details)
            self.assertEqual(ts_error["errorInfo"], dict(error.error_info))

    def test_real_session_tree_branches_and_fork_for_sync_async_and_ts(self):
        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                chunk = {"id": "offline", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "离线回复"}, "finish_reason": "stop"}]}
                self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode("utf-8"))
                self.wfile.flush()
            def log_message(self, *_args):
                pass
        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-session-bridge-") as directory, \
                    patch.dict(os.environ, {"COREMIND_TASK_TEST_KEY": "offline-test-only"}):
                workspace = Path(directory)
                config = configuration(f"http://127.0.0.1:{model.server_port}/v1")
                options = {"protocol_version": "2.0", "config_dir": workspace, "cwd": workspace,
                           "session_id": "shared", "request_timeout": 10}
                with CoreMindClient(config, **options) as client:
                    with self.assertRaises(ProtocolError) as unsupported:
                        client.task_query("job")
                    self.assertEqual(unsupported.exception.coremind_code, "protocol_capability_missing")
                    run = client.chat("共同的历史")
                    limit = time.monotonic() + 10
                    while client.query(run["runId"])["projection"]["status"] != "finished":
                        self.assertLess(time.monotonic(), limit)
                        time.sleep(0.01)
                    tree = client.inspect_session_tree()["tree"]
                    entry = next(node["id"] for node in tree["nodes"] if node.get("message", {}).get("role") == "user")
                    ref = {"sessionId": "shared", "entryId": entry}
                    client.create_session_branch("alternate", ref)
                    client.select_session_branch("alternate")
                    fork = client.fork_session(ref)["tree"]
                    self.assertNotEqual(fork["sessionId"], "shared")
                    self.assertEqual(fork["forkedFrom"], ref)
                    with self.assertRaises(ProtocolError) as unauthorized:
                        client.fork_session({"sessionId": "other", "entryId": entry})
                    self.assertEqual(unauthorized.exception.coremind_code, "session_navigation_invalid")
                inspected, ts_fork = self._ts(workspace, config,
                    {"method": "session", "command": {"action": "inspect"}},
                    {"method": "session", "command": {"action": "fork", "at": ref}})
                self.assertEqual(inspected["tree"]["activeBranch"], "alternate")
                self.assertEqual(ts_fork["tree"]["nodes"], fork["nodes"])
                async def check_async():
                    async with AsyncCoreMindClient(config, **options) as client:
                        self.assertEqual((await client.inspect_session_tree())["tree"], inspected["tree"])
                        await client.create_session_branch("async", ref)
                        await client.select_session_branch("async")
                        self.assertEqual((await client.fork_session(ref))["tree"]["nodes"], fork["nodes"])
                asyncio.run(check_async())
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)

    def test_capability_callable_and_malformed_identity_fail_closed(self):
        client = CoreMindClient(configuration(), protocol_version="2.0")
        with patch.object(client, "start"), patch.object(client, "_request_raw") as request:
            with self.assertRaises(ProtocolError) as missing:
                client.task_query("job")
            self.assertEqual(missing.exception.coremind_code, "protocol_capability_missing")
            with self.assertRaises(ProtocolError):
                client.task_start("job", "wait", lambda: None)
            request.assert_not_called()
        params = {"sessionId": "shared", "action": "query", "taskId": "job"}
        good = {"schemaVersion": 1, **params, "task": None}
        self.assertEqual(validate_management_result(good, "task", params), good)
        for changed in ({"sessionId": "other"}, {"taskId": "other"}, {"schemaVersion": True},
                        {"task": {"taskId": "job", "type": "x", "version": 1, "phase": "a", "checkpoint": None, "status": []}}):
            with self.subTest(changed=changed), self.assertRaises(ProtocolError):
                validate_management_result({**good, **changed}, "task", params)
        error = ProtocolError("wrong", rpc_code=-32000, coremind_code="unclassified_error",
                              details={"operation": "task", **params, "sessionId": "other"})
        with self.assertRaises(ProtocolError) as caught:
            validate_management_error(error, "task", params)
        self.assertEqual(caught.exception.coremind_code, "protocol_validation_failed")


if __name__ == "__main__":
    unittest.main()
