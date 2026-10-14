from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import coremind
from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError


@unittest.skipUnless(sys.platform == "linux", "需要 Linux 真实沙箱与随包 Worker")
class SandboxLifecycleTest(unittest.TestCase):
    def test_sync_v1_close_removes_owned_helper(self) -> None:
        self._check_lifecycle("1.0", asynchronous=False)

    def test_sync_v2_eof_removes_owned_helper(self) -> None:
        self._check_lifecycle("2.0", asynchronous=False)

    def test_async_v1_close_removes_owned_helper(self) -> None:
        self._check_lifecycle("1.0", asynchronous=True)

    def test_async_v2_eof_removes_owned_helper(self) -> None:
        self._check_lifecycle("2.0", asynchronous=True)

    def _check_lifecycle(self, protocol: str, *, asynchronous: bool) -> None:
        requests: list[dict[str, object]] = []

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                size = int(self.headers["Content-Length"])
                requests.append(json.loads(self.rfile.read(size)))
                if len(requests) == 1:
                    delta = {
                        "role": "assistant",
                        "tool_calls": [{
                            "index": 0,
                            "id": "sandbox-lifecycle-call",
                            "type": "function",
                            "function": {
                                "name": "bash",
                                "arguments": json.dumps({
                                    "command": "printf sandbox-lifecycle-ok",
                                    "timeout": 5,
                                }),
                            },
                        }],
                    }
                    finish_reason = "tool_calls"
                else:
                    delta = {"role": "assistant", "content": "沙箱命令已完成"}
                    finish_reason = "stop"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for content, reason in ((delta, None), ({}, finish_reason)):
                    chunk = {
                        "id": "sandbox-lifecycle",
                        "choices": [{"index": 0, "delta": content, "finish_reason": reason}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-sandbox-lifecycle-") as directory:
                root = Path(directory)
                workspace = root / "workspace"
                temporary_root = root / "private-tmp"
                workspace.mkdir()
                temporary_root.mkdir()
                config = {
                    "schemaVersion": 2,
                    "name": "沙箱正常关闭验收",
                    "provider": {
                        "id": "sandbox-lifecycle",
                        "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                        "model": "sandbox-lifecycle-model",
                        "apiKeyEnv": "COREMIND_SANDBOX_LIFECYCLE_KEY",
                    },
                    "tools": [{"id": "bash"}],
                    "agents": {"main": {"systemPrompt": "执行指定沙箱命令后结束"}},
                    "permissions": {"mode": "full", "workspaceOnly": True, "network": "deny"},
                    "runtime": {"maxTurns": 4, "maxToolCalls": 2, "runTimeoutMs": 20_000},
                }
                with patch.dict(os.environ, {
                    "TMPDIR": str(temporary_root),
                    "TMP": str(temporary_root),
                    "TEMP": str(temporary_root),
                    "COREMIND_SANDBOX_LIFECYCLE_KEY": "offline-test-only",
                }):
                    os.environ.pop("COREMIND_WORKER_PATH", None)
                    asyncio.run(self._exercise_client(
                        config, workspace, temporary_root, requests, protocol, asynchronous,
                    ))
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)

    async def _exercise_client(
        self,
        config: dict[str, object],
        workspace: Path,
        temporary_root: Path,
        requests: list[dict[str, object]],
        protocol: str,
        asynchronous: bool,
    ) -> None:
        bundled_worker = Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs"
        self.assertTrue(bundled_worker.is_file(), "测试需要已经构建的随包 Worker")
        client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
        client = client_type(
            config, protocol_version=protocol, config_dir=workspace, cwd=workspace,
            request_timeout=20,
        )
        if asynchronous:
            await client.start()
        else:
            client.start()
        sync_client = client.sync_client if asynchronous else client
        process = sync_client._process
        self.assertIsNotNone(process)
        helper_directory: Path | None = None
        with patch.object(process, "terminate", wraps=process.terminate) as terminate, \
             patch.object(process, "kill", wraps=process.kill) as kill:
            try:
                self.assertEqual(Path(process.args[1]).resolve(), bundled_worker)
                run_id = f"sandbox-{protocol.replace('.', '-')}-{'async' if asynchronous else 'sync'}"
                if asynchronous:
                    result = await client.run("执行沙箱命令", run_id=run_id)
                else:
                    result = client.run("执行沙箱命令", run_id=run_id)
                if protocol == "2.0":
                    deadline = time.monotonic() + 20
                    while True:
                        try:
                            projection = await client.query(run_id) if asynchronous else client.query(run_id)
                        except ProtocolError as error:
                            if error.coremind_code != "unknown_run":
                                raise
                        else:
                            if projection["projection"]["status"] == "finished":
                                self.assertEqual(projection["projection"]["outcome"]["status"], "succeeded")
                                self.assertEqual(projection["projection"]["snapshot"]["metrics"]["toolCalls"], 1)
                                break
                        self.assertLess(time.monotonic(), deadline, "真实 bash Run 未完成")
                        await asyncio.sleep(0.02)
                else:
                    self.assertEqual(result["outcome"]["status"], "succeeded")
                    self.assertEqual(result["metrics"]["toolCalls"], 1)
                self.assertEqual(len(requests), 2, "必须执行真实工具调用后再结束")
                tool_messages = [
                    message for message in requests[-1]["messages"] if message.get("role") == "tool"
                ]
                self.assertIn("sandbox-lifecycle-ok", json.dumps(tool_messages))
                helpers = list(temporary_root.glob("coremind-seccomp-*"))
                self.assertEqual(len(helpers), 1, "关闭前必须存在一个真实分配的 helper")
                helper_directory = helpers[0]
                self.assertTrue((helper_directory / "apply-seccomp").is_file())
                self.assertIsNone(process.poll(), "关闭前 Worker 必须仍然存活")
            finally:
                if asynchronous:
                    await client.close()
                else:
                    client.close()
            observation = {
                "protocol": protocol,
                "asynchronous": asynchronous,
                "pid": process.pid,
                "returncode": process.returncode,
                "terminateCalls": terminate.call_count,
                "killCalls": kill.call_count,
            }
            self.assertEqual(process.returncode, 0, observation)
            self.assertTrue(process.stdin.closed, observation)
            terminate.assert_not_called()
            kill.assert_not_called()
            self.assertIsNotNone(helper_directory)
            # 必须先断言产品删除，不能由外层 TemporaryDirectory 清理掩盖遗留。
            self.assertFalse(helper_directory.exists(), f"正常退出后 helper 遗留：{helper_directory}")


if __name__ == "__main__":
    unittest.main()
