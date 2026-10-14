from __future__ import annotations

import asyncio
import hashlib
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


FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "mcp-stdio-server.mjs"
SECRET = "python-mcp-private-value-739026"
BUSINESS_ARGS = {"value": {"flag": False, "count": 0, "empty": None}}
INPUT_SCHEMA = {
    "type": "object", "$defs": {"value": {}},
    "properties": {"value": {"$ref": "#/$defs/value"}},
    "required": ["value"], "additionalProperties": False,
}


class McpStdioTest(unittest.TestCase):
    def test_sync_bundled_worker_approves_and_rejects_local_tool(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=False, denied=denied))

    def test_async_bundled_worker_approves_and_rejects_local_tool(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=True, denied=denied))

    async def _check(self, *, asynchronous: bool, denied: bool) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        self.assertTrue(FIXTURE.is_file(), "测试需要仓库的真实本地服务夹具")
        requests: list[dict] = []
        errors: list[Exception] = []
        approvals: list[dict] = []
        live_at_business: list[list[bool]] = []

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    if len(requests) == 1:
                        name = request["tools"][0]["function"]["name"]
                        delta = {"role": "assistant", "tool_calls": [{
                            "index": 0, "id": "python-mcp-business", "type": "function",
                            "function": {"name": name, "arguments": json.dumps(BUSINESS_ARGS)},
                        }]}
                        reason = "tool_calls"
                    else:
                        delta = {"role": "assistant", "content": "本地服务执行完成"}
                        reason = "stop"
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for content, finish in ((delta, None), ({}, reason)):
                        chunk = {"id": f"python-mcp-{len(requests)}", "choices": [{
                            "index": 0, "delta": content, "finish_reason": finish,
                        }]}
                        self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    errors.append(error)

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        model.daemon_threads = True
        server_thread = Thread(target=model.serve_forever, daemon=True)
        server_thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-python-mcp-") as directory, \
                    patch.dict(os.environ, {
                        "COREMIND_TEST_API_KEY": "offline-test-only", "MCP_TEST_SECRET": SECRET,
                        "COREMIND_MCP_UNLISTED": "host-only",
                    }):
                os.environ.pop("COREMIND_WORKER_PATH", None)
                workspace = Path(directory)
                record_file = workspace / "service.jsonl"

                def approve(request: dict) -> str:
                    approvals.append(dict(request))
                    if len(approvals) == 3:
                        try:
                            started = next(record for record in service_records(record_file)
                                           if record.get("type") == "started")
                            live_at_business.append(probe_pids(node, [started["pid"], started["childPid"]]))
                        except Exception as error:
                            errors.append(error)
                            return "deny"
                    return "deny" if denied and len(approvals) == 3 else "allow"

                capability = {"effect": "external", "replay": "unknown", "concurrency": "run_serial",
                              "checkpoint": "unsupported", "durability": "critical"}
                effect = {"operations": ["external"], "reversible": False}
                env_references = {"MCP_TEST_SECRET": {"env": "MCP_TEST_SECRET"}}
                config = {
                    "schemaVersion": 2, "name": "Python 本地服务真实验收",
                    "provider": {"id": "probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                 "model": "probe-model", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                    "mcp": {"servers": {"local": {
                        "transport": "stdio", "command": node, "args": [str(FIXTURE), str(record_file)],
                        "cwd": directory, "env": env_references,
                    }}},
                    "agents": {"main": {"tools": [{
                        "mcp": {"server": "local", "tool": "echo"},
                        "effect": effect, "capability": capability,
                    }]}},
                    "permissions": {"mode": "ask", "workspaceOnly": False, "network": "allow"},
                    "runtime": {"maxTurns": 3, "maxRetries": 0, "maxToolCalls": 3, "runTimeoutMs": 20_000},
                }
                client = (AsyncCoreMindClient if asynchronous else CoreMindClient)(
                    config, protocol_version="2.0", config_dir=workspace, cwd=workspace,
                    approval_handler=approve, request_timeout=25,
                )

                async def invoke(method: str, *args, **kwargs):
                    result = getattr(client, method)(*args, **kwargs)
                    return await result if asynchronous else result

                await invoke("start")
                sync_client = client.sync_client if asynchronous else client
                process = sync_client._process
                self.assertIsNotNone(process)
                bundled = Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs"
                self.assertEqual(Path(process.args[1]).resolve(), bundled)
                with patch.object(process, "terminate", wraps=process.terminate) as terminate, \
                        patch.object(process, "kill", wraps=process.kill) as kill:
                    try:
                        run_id = f"python-mcp-{'async' if asynchronous else 'sync'}-{'deny' if denied else 'allow'}"
                        handle = await invoke("run", "调用已选择的本地回声工具", run_id=run_id)
                        self.assertEqual((handle["runId"], handle["selectedProtocol"]), (run_id, "2.0"))
                        events = await self._read_finished(invoke, run_id)
                        outcome = events[-1]["payload"]["outcome"]
                        self.assertEqual(outcome["status"], "paused" if denied else "succeeded", outcome)
                        if denied:
                            self.assertEqual(outcome["finishReason"], "tool_approval_denied")
                        projection = (await invoke("query", run_id))["projection"]
                        self.assertEqual(projection["outcome"]["status"], outcome["status"])
                        self.assertEqual(len(requests), 1 if denied else 2)
                        self.assertEqual(len(approvals), 3)
                        self.assertEqual(live_at_business, [[True, True]])
                        self.assertEqual(len({request["approvalId"] for request in approvals}), 3)
                        declared = requests[0]["tools"]
                        self.assertEqual(len(declared), 1)
                        function = declared[0]["function"]
                        self.assertEqual(function["parameters"], INPUT_SCHEMA)
                        self.assertRegex(function["name"], r"^mcp_[A-Za-z0-9_-]+$")
                        self.assertTrue(approvals[0]["tool"].startswith("mcp_connect_"))
                        self.assertTrue(approvals[1]["tool"].startswith("mcp_list_"))
                        self.assertEqual(approvals[2]["tool"], function["name"])
                        self.assertEqual(approvals[0]["args"]["operation"], "connect")
                        self.assertEqual(approvals[1]["args"]["operation"], "list")
                        self.assertEqual(approvals[1]["args"]["tools"], ["echo"])
                        self.assertEqual([approval["capability"]["effect"] for approval in approvals],
                                         ["process", "external", "external"])
                        command_sha256 = hashlib.sha256(Path(node).read_bytes()).hexdigest()
                        script_sha256 = hashlib.sha256(FIXTURE.read_bytes()).hexdigest()
                        for ordinal, approval in enumerate(approvals):
                            self.assertEqual(approval["runId"], run_id)
                            self.assertRegex(approval["argumentsFingerprint"], r"^[0-9a-f]{64}$")
                            target = approval["args"] if ordinal < 2 else approval["args"]["mcp"]
                            self.assertEqual(target["server"], "local")
                            self.assertEqual(Path(target["command"]).resolve(), Path(node).resolve())
                            self.assertEqual(Path(target["cwd"]).resolve(), workspace.resolve())
                            self.assertEqual(target["argv"], [str(FIXTURE), str(record_file)])
                            self.assertRegex(target["serverIdentity"], r"^[0-9a-f]{64}$")
                            self.assertEqual(target["commandSha256"], command_sha256)
                            self.assertEqual(target["scripts"], [{
                                "argumentIndex": 0, "path": str(FIXTURE.resolve()),
                                "sha256": script_sha256,
                            }])
                        envelope = approvals[2]["args"]
                        self.assertEqual(envelope["arguments"], BUSINESS_ARGS)
                        self.assertEqual(envelope["mcp"]["tool"], "echo")
                        self.assertEqual(envelope["mcp"]["schemaSha256"], fingerprint({"inputSchema": INPUT_SCHEMA}))
                        self.assertEqual(envelope["mcp"]["effect"], effect)
                        self.assertEqual(envelope["mcp"]["capability"], capability)
                        original_envelope = json.loads(json.dumps(envelope))
                        original_envelope["mcp"]["envReferences"] = env_references
                        self.assertEqual(approvals[2]["argumentsFingerprint"], fingerprint(original_envelope))
                        records = service_records(record_file)
                        self.assertIn({"type": "environment", "allowed": True, "forbidden": False}, records)
                        self.assertEqual(len([record for record in records if record.get("method") == "initialize"]), 1)
                        self.assertEqual(len([record for record in records if record.get("method") == "tools/list"]), 2)
                        calls = [record for record in records if record.get("method") == "tools/call"]
                        self.assertEqual(len(calls), 0 if denied else 1)
                        if calls:
                            self.assertEqual(calls[0]["params"], {"name": "echo", "arguments": BUSINESS_ARGS})
                        self.assertFalse(any(event["eventType"] == "quiescence_timeout" for event in events))
                        self.assertEqual(any(event["eventType"] == "policy_denied" for event in events), denied)
                        self.assertNotIn(SECRET, json.dumps({
                            "requests": requests, "events": events, "projection": projection,
                            "approvals": approvals, "notifications": sync_client.received_events,
                            "errors": [str(error) for error in errors], "stderr": list(sync_client._stderr_tail),
                        }))
                        self.assertEqual(errors, [])
                        started = next(record for record in records if record.get("type") == "started")
                        self.assertIn({"type": "child-ready", "pid": started["childPid"]}, records)
                        deadline = time.monotonic() + 3
                        while probe_pids(node, [started["pid"], started["childPid"]]) != [False, False]:
                            self.assertLess(time.monotonic(), deadline, "Run 终态后本地服务树仍存活")
                            await asyncio.sleep(0.02)
                        self.assertIsNone(process.poll(), "服务树关闭不能靠退出整个 Worker 完成")
                    finally:
                        await invoke("close")
                    self.assertEqual(process.returncode, 0)
                    self.assertTrue(process.stdin.closed)
                    terminate.assert_not_called()
                    kill.assert_not_called()
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
            self.assertLess(time.monotonic(), deadline, "真实本地服务 Run 未形成持久终态")
            if any(event["eventType"] in {"fact.finish", "fact.pause"} for event in page["events"]):
                self.assertEqual([event["sequence"] for event in events], list(range(1, cursor + 1)))
                return events
            await asyncio.sleep(0.02)


def service_records(file: Path) -> list[dict]:
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line]


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":")).encode("utf-8")).hexdigest()


def probe_pids(node: str, pids: list[int]) -> list[bool]:
    # Windows 的 Python os.kill(pid, 0) 不适合查询存活；使用 Node 的无信号查询。
    script = """process.stdout.write(JSON.stringify(process.argv.slice(1).map(value => {
      try { process.kill(Number(value), 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    })))"""
    result = subprocess.run(
        [node, "-e", script, *(str(pid) for pid in pids)], check=True, capture_output=True,
        text=True, encoding="utf-8", timeout=5,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return json.loads(result.stdout)


if __name__ == "__main__":
    unittest.main()
