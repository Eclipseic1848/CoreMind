from __future__ import annotations

import hashlib
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

import coremind
from coremind import CoreMindClient


FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "mcp-http-server.mjs"
CONTENT = "artifact-head-739027\n" + "p" * (24 * 1024) + "\nartifact-tail-846032"
LAUNCHER = """
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const { startMcpHttpServer } = await import(pathToFileURL(process.argv[2]).href);
const service = await startMcpHttpServer();
const commands = createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ url: service.url }) + '\\n');
try {
  for await (const line of commands) {
    if (JSON.parse(line).action === 'close') break;
    process.stdout.write(JSON.stringify({ records: service.records, sockets: service.sockets.size }) + '\\n');
  }
} finally { commands.close(); process.stdin.pause(); await service.close(); }
"""


class TerminalArtifactIdentityTest(unittest.TestCase):
    def test_real_default_worker_forwards_batch_artifact_call_sources(self) -> None:
        for version in ("1.0", "2.0"):
            with self.subTest(version=version):
                self._check(version, workflow=False)

    def test_real_default_worker_forwards_cross_agent_step_artifact_sources(self) -> None:
        for version in ("1.0", "2.0"):
            with self.subTest(version=version):
                self._check(version, workflow=True)

    def _check(self, version: str, *, workflow: bool) -> None:
        requests, model_errors, aliases, expected_sources = [], [], set(), {}
        test = self

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
                    requests.append(body)
                    finished = any(message.get("role") == "tool" for message in body["messages"])
                    if finished:
                        test.assertIn("Artifact: .coremind/artifacts/", json.dumps(body["messages"], ensure_ascii=False))
                        delta = {"role": "assistant", "content": "大输出验收完成"}
                    else:
                        test.assertEqual(len(body["tools"]), 1)
                        name = body["tools"][0]["function"]["name"]
                        aliases.add(name)
                        ids = ["same-call"] if workflow else ["call-left", "call-right"]
                        step = None
                        if workflow:
                            users = [message["content"] for message in body["messages"] if message.get("role") == "user"]
                            text = users[-1]
                            if isinstance(text, list):
                                text = "".join(part.get("text", "") for part in text)
                            test.assertIn(text, ("a", "b"))
                            step = text
                        calls = []
                        for index, call_id in enumerate(ids):
                            marker = f"artifact-owner:{step or call_id}"
                            source = {"agent": "peer" if step == "b" else "main", "callId": call_id, "tool": name}
                            if step is not None:
                                source["stepId"] = step
                            value = CONTENT + "\n" + marker
                            expected_sources[value] = source
                            calls.append({"index": index, "id": call_id, "type": "function",
                                          "function": {"name": name, "arguments": json.dumps({"value": value})}})
                        delta = {"role": "assistant", "tool_calls": calls}
                    chunks = [{"id": "artifact-identity", "choices": [{
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

        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        model.daemon_threads = True
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        try:
            with _fixture(self) as service, tempfile.TemporaryDirectory(prefix="coremind-python-artifact-identity-") as temporary, \
                    patch.dict(os.environ, {"COREMIND_TEST_API_KEY": "offline-test-only"}):
                for name in ("NODE_OPTIONS", "NODE_PATH", "COREMIND_WORKER_PATH"):
                    os.environ.pop(name, None)
                directory = Path(temporary)
                # 真实 echo 无共享业务写；配置完整显式授权 parallel，保留原生产通道约束。
                selected = {"mcp": {"server": "remote", "tool": "echo"},
                            "effect": {"operations": ["network"], "reversible": False},
                            "capability": {"effect": "network", "replay": "unknown", "concurrency": "parallel",
                                           "checkpoint": "none", "durability": "critical"}}
                config = {
                    "schemaVersion": 2, "name": "Python Artifact 来源身份验收",
                    "provider": {"id": "artifact-probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                 "model": "probe", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                    "mcp": {"servers": {"remote": {"transport": "streamable-http", "url": service.url,
                                                   "allowedAddresses": ["127.0.0.1"]}}},
                    "agents": {"main": {"tools": [selected]}},
                    "permissions": {"mode": "ask", "workspaceOnly": True, "network": "allow"},
                    "runtime": {"maxTurns": 8, "maxToolCalls": 10, "maxRetries": 0, "runTimeoutMs": 10_000},
                }
                if workflow:
                    config["agents"]["peer"] = {"tools": [selected]}
                    config["workflow"] = [{"id": "parallel", "type": "parallel", "steps": [
                        {"id": "a", "type": "prompt", "agent": "main", "input": "a"},
                        {"id": "b", "type": "prompt", "agent": "peer", "input": "b"},
                    ]}]
                client = CoreMindClient(config, protocol_version=version, config_dir=directory, cwd=directory,
                                        approval_handler=lambda _request: "allow", request_timeout=20)
                process = None
                try:
                    client.start()
                    process = client._process
                    self.assertIsNotNone(process)
                    self.assertEqual(Path(process.args[1]).resolve(),
                                     Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs")
                    result = client.run("调用已授权工具产生大输出", run_id="artifact-identity")
                    if version == "2.0":
                        durable = self._finished(client, result["runId"])
                        projection = client.query(result["runId"])["projection"]
                        snapshot, trace = projection["snapshot"], projection["trace"]
                    else:
                        snapshot, trace = result["snapshot"], result["trace"]
                    self.assertEqual(snapshot["outcome"]["status"], "succeeded", snapshot["outcome"])
                    self.assertEqual(model_errors, [])
                    self.assertEqual(len(requests), 4 if workflow else 2)
                    events = [entry["event"] for entry in trace]
                    artifacts = [event for event in events if event["type"] == "artifact_created"]
                    calls = [event for event in events if event["type"] == "tool_call" and event["tool"] in aliases]
                    records = snapshot["artifacts"]
                    self.assertEqual((len(artifacts), len(calls), len(records)), (2, 2, 2))
                    self.assertEqual(len(expected_sources), 2)
                    self.assertEqual(len({record["artifactId"] for record in records}), 2)
                    actual_values = []
                    for record in records:
                        self.assertEqual(record["status"], "stored")
                        self.assertRegex(record["relativePath"], r"^\.coremind/artifacts/[A-Za-z0-9_-]+\.log$")
                        data = (directory / record["relativePath"]).read_bytes()
                        self.assertEqual(len(data), record["sizeBytes"])
                        self.assertEqual(hashlib.sha256(data).hexdigest(), record["sha256"])
                        stored = json.loads(data.decode("utf-8"))["mcp"]
                        value = json.loads(stored["content"][0]["text"])
                        self.assertIn(value, expected_sources)
                        actual_values.append(value)
                        self.assertEqual(stored["structuredContent"]["result"], value)
                        event = next(item for item in artifacts if item["artifactId"] == record["artifactId"])
                        for field in ("status", "relativePath", "sizeBytes", "sha256"):
                            self.assertEqual(event[field], record[field])
                        source = expected_sources[value]
                        self.assertEqual({field: event[field] for field in ("agent", "stepId", "callId", "tool") if field in event}, source)
                        self.assertEqual(len([call for call in calls if all(call.get(field) == source.get(field)
                                                                        for field in ("agent", "stepId", "callId", "tool"))]), 1)
                    self.assertEqual(set(actual_values), set(expected_sources))
                    self.assertEqual(self._sources(artifacts), self._sources(calls))
                    if workflow:
                        self.assertEqual(sorted((call["agent"], call["stepId"], call["callId"]) for call in calls),
                                         [("main", "a", "same-call"), ("peer", "b", "same-call")])
                    else:
                        self.assertEqual(sorted(call["callId"] for call in calls), ["call-left", "call-right"])
                        self.assertTrue(all("stepId" not in event for event in artifacts))
                    # 通知保留真实 Mapping；仅比较合同字段，不把 live 全事件冒充 canonical Trace。
                    live = [item["event"] for item in client.received_events
                            if item.get("event", {}).get("type") == "artifact_created"]
                    self._assert_artifacts(live, artifacts)
                    if version == "2.0":
                        envelopes = [event for event in durable if event["eventType"] == "artifact_created"]
                        self._assert_artifacts([event["payload"] for event in envelopes], artifacts)
                        for envelope in envelopes:
                            for field in ("callId", "stepId"):
                                self.assertEqual(envelope.get(field), envelope["payload"].get(field))
                finally:
                    if process is None:
                        client.close()
                    else:
                        with patch.object(process, "terminate", wraps=process.terminate) as terminate, \
                                patch.object(process, "kill", wraps=process.kill) as kill:
                            client.close()
                            self.assertEqual(process.returncode, 0)
                            terminate.assert_not_called()
                            kill.assert_not_called()
                        self.assertTrue(all(stream.closed for stream in (process.stdin, process.stdout, process.stderr)))
                        self.assertFalse(client._reader.is_alive())
                        self.assertFalse(client._stderr_reader.is_alive())
                inspection = service.inspect()
                self.assertEqual(len([item for item in inspection["records"]
                                      if item.get("type") == "request" and item.get("method") == "tools/call"]), 2)
                self.assertEqual(inspection["sockets"], 0)
        finally:
            model.shutdown()
            model.server_close()
            model_thread.join(timeout=5)
            self.assertFalse(model_thread.is_alive())

    def _sources(self, events):
        return sorted(((event.get("agent"), event.get("stepId"), event.get("callId"), event["tool"])
                       for event in events), key=lambda identity: json.dumps(identity))

    def _assert_artifacts(self, actual, expected):
        fields = ("artifactId", "agent", "stepId", "callId", "tool", "status", "relativePath", "sizeBytes", "sha256")
        select = lambda items: sorted(({field: item[field] for field in fields if field in item} for item in items),
                                      key=lambda item: item["artifactId"])
        self.assertEqual(select(actual), select(expected))

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
        self.fail("Artifact 业务 Run 未形成持久终态")


@contextmanager
def _fixture(test):
    node = shutil.which("node")
    test.assertIsNotNone(node, "测试需要 Node.js")
    test.assertTrue(FIXTURE.is_file(), "测试需要唯一真实 HTTP MCP 夹具")
    # argv[1] 是本测试 wrapper，避免导入的共享夹具把自身误判为直接执行入口。
    process = subprocess.Popen([node, "--input-type=module", "--eval", LAUNCHER,
                                "coremind-artifact-test-wrapper", str(FIXTURE)],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    responses = queue.Queue(maxsize=16)
    stdout, stderr = [], []

    def read():
        try:
            for line in process.stdout:
                stdout.append(line)
                responses.put(json.loads(line))
        finally:
            responses.put(None)

    def read_errors():
        for line in process.stderr:
            stderr.append(line)

    def receive():
        value = responses.get(timeout=5)
        if value is None:
            raise AssertionError("唯一 HTTP 夹具未返回预期 JSON 即关闭 stdout")
        return value

    reader = threading.Thread(target=read, daemon=True)
    stderr_reader = threading.Thread(target=read_errors, daemon=True)
    reader.start()
    stderr_reader.start()

    class Fixture:
        url = ""

        def inspect(self):
            process.stdin.write('{"action":"inspect"}\n')
            process.stdin.flush()
            return receive()

    primary_error = None
    try:
        fixture = Fixture()
        fixture.url = receive()["url"]
        yield fixture
    except BaseException as error:
        primary_error = error
    finally:
        cleanup_failure = None
        try:
            try:
                if process.poll() is None:
                    process.stdin.write('{"action":"close"}\n')
                    process.stdin.flush()
            except OSError:
                cleanup_failure = "唯一 HTTP 夹具命令管道提前关闭"
            finally:
                try:
                    process.stdin.close()
                except OSError:
                    cleanup_failure = "唯一 HTTP 夹具命令管道关闭失败"
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                cleanup_failure = "唯一 HTTP 夹具未自然退出，已回收测试自有进程"
        finally:
            if not process.stdin.closed:
                try:
                    process.stdin.close()
                except OSError:
                    cleanup_failure = "唯一 HTTP 夹具命令管道关闭失败"
            reader.join(timeout=2)
            stderr_reader.join(timeout=2)
            process.stdout.close()
            process.stderr.close()
    diagnostic = f"stdout:\n{''.join(stdout)}\nstderr:\n{''.join(stderr)}"
    if primary_error is not None:
        # 先完整收尾，再保留原异常及子进程 stderr；退出码断言不能覆盖真正启动错误。
        if stderr or cleanup_failure:
            raise AssertionError(f"{primary_error}\n{diagnostic}\n清理: {cleanup_failure}") from primary_error
        raise primary_error
    if cleanup_failure:
        test.fail(f"{cleanup_failure}\n{diagnostic}")
    test.assertEqual(process.returncode, 0, diagnostic)
    test.assertFalse(reader.is_alive())
    test.assertFalse(stderr_reader.is_alive())


if __name__ == "__main__":
    unittest.main()
