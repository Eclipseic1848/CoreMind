from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread

from coremind import CoreMindClient, ProtocolError


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class NodeRuntimeParityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.previous_test_api_key = os.environ.get("COREMIND_TEST_API_KEY")
        os.environ["COREMIND_TEST_API_KEY"] = "test-only"

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.previous_test_api_key is None:
            os.environ.pop("COREMIND_TEST_API_KEY", None)
        else:
            os.environ["COREMIND_TEST_API_KEY"] = cls.previous_test_api_key

    def test_bundled_worker_rejects_secret_ref_without_resolver_without_leakage(self) -> None:
        opaque_ref = "opaque/python/key/never-log"
        config = {
            "schemaVersion": 2,
            "name": "Python SecretRef 安全失败",
            "provider": {
                "id": "probe",
                "baseUrl": "http://127.0.0.1:9/v1",
                "model": "probe-model",
                "apiKeySecretRef": {"secretRef": opaque_ref},
            },
            "agents": {"main": {}},
        }
        with tempfile.TemporaryDirectory(prefix="coremind-python-secret-ref-") as directory:
            client = CoreMindClient(config, config_dir=directory, cwd=directory)
            with self.assertRaises(ProtocolError) as captured:
                client.start()
            client.close()

        self.assertEqual(captured.exception.coremind_code, "secret_reference_unresolved")
        self.assertNotIn(opaque_ref, str(captured.exception))

    def test_protocol_v2_uses_bundled_node_worker(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        port = _free_port()
        mock_server = subprocess.Popen(
            [
                node,
                str(REPOSITORY_ROOT / "packages" / "coremind-cli" / "test" / "mock-openai-server.mjs"),
                str(port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _wait_for_port(port)
            with tempfile.TemporaryDirectory(prefix="coremind-python-v2-") as directory:
                config = {
                    "schemaVersion": 2,
                    "name": "Python Protocol v2 真实入口",
                    "provider": {
                        "id": "probe",
                        "baseUrl": f"http://127.0.0.1:{port}/v1",
                        "model": "probe-model",
                        "apiKeyEnv": "COREMIND_TEST_API_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "测试助手"}},
                }
                with CoreMindClient(
                    config,
                    protocol_version="2.0",
                    config_dir=directory,
                    cwd=directory,
                    request_timeout=20,
                ) as client:
                    handle = client.run("你好", run_id="python-real-v2")
                    projection = None
                    for _attempt in range(100):
                        try:
                            projection = client.query("python-real-v2")
                        except ProtocolError:
                            time.sleep(0.02)
                            continue
                        if projection["projection"]["status"] == "finished":
                            break
                        time.sleep(0.02)
                    events = client.events("python-real-v2", after_sequence=0, limit=100)

            self.assertEqual(handle["selectedProtocol"], "2.0")
            self.assertEqual(handle["runId"], "python-real-v2")
            self.assertIsNotNone(projection)
            self.assertEqual(projection["projection"]["status"], "finished")
            self.assertGreater(events["nextCursor"], 0)
            self.assertTrue(events["events"])
        finally:
            mock_server.terminate()
            try:
                mock_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_server.kill()
                mock_server.wait(timeout=2)

    def test_protocol_v2_sends_complete_registered_tool_schemas_to_model(self) -> None:
        requests: list[dict[str, object]] = []
        received = Event()

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                size = int(self.headers["Content-Length"])
                requests.append(json.loads(self.rfile.read(size)))
                received.set()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for chunk in (
                    {"id": "schema", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "ok"}, "finish_reason": None}]},
                    {"id": "schema", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
                ):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-v2-tool-schema-") as directory:
                config = {
                    "schemaVersion": 2,
                    "name": "v2 工具 Schema",
                    "provider": {
                        "id": "probe",
                        "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                        "model": "probe-model",
                        "apiKeyEnv": "COREMIND_TEST_API_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "验证工具参数"}},
                }
                read_schema = {
                    "type": "object",
                    "properties": {"source_id": {"type": "string"}},
                    "required": ["source_id"],
                    "additionalProperties": False,
                }
                write_schema = {
                    "type": "object",
                    "properties": {
                        "target": {"type": "string"},
                        "options": {
                            "type": "object",
                            "properties": {"overwrite": {"type": "boolean"}},
                            "required": ["overwrite"],
                            "additionalProperties": False,
                        },
                    },
                    "required": ["target", "options"],
                    "additionalProperties": False,
                }
                definitions = (
                    ("read_source", "read", "none", "parallel", "none", "ordinary", read_schema),
                    ("write_target", "write", "workspace", "workspace_exclusive", "required", "critical", write_schema),
                )
                with CoreMindClient(
                    config, protocol_version="2.0", config_dir=directory, cwd=directory,
                    request_timeout=20,
                ) as client:
                    for name, operation, effect, concurrency, checkpoint, durability, schema in definitions:
                        receipt = client.register_tool_definition({
                            "schemaVersion": 1,
                            "registrationId": f"registration-{name}",
                            "definitionVersion": 1,
                            "toolId": name,
                            "name": name,
                            "description": name,
                            "parameters": schema,
                            "effect": {"operations": [operation], "reversible": True},
                            "capability": {
                                "effect": effect,
                                "replay": "safe",
                                "concurrency": concurrency,
                                "checkpoint": checkpoint,
                                "durability": durability,
                            },
                        })
                        self.assertEqual(receipt["status"], "registered")
                    client.run("检查工具合同", run_id="tool-schema-run")
                    self.assertTrue(received.wait(10), "模型未收到工具请求")

            tools = {item["function"]["name"]: item["function"]["parameters"] for item in requests[0]["tools"]}
            self.assertEqual(tools["read_source"], read_schema)
            self.assertEqual(tools["write_target"], write_schema)
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)

    def test_bundled_worker_exposes_child_run_result_events_and_projection(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        port = _free_port()
        mock_server = subprocess.Popen(
            [
                node,
                str(
                    REPOSITORY_ROOT
                    / "packages"
                    / "coremind-cli"
                    / "test"
                    / "mock-delegation-server.mjs"
                ),
                str(port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _wait_for_port(port)
            config = _delegation_config(port)
            with tempfile.TemporaryDirectory(prefix="coremind-python-child-v1-") as directory:
                with CoreMindClient(
                    config,
                    config_dir=directory,
                    cwd=directory,
                    request_timeout=20,
                ) as client:
                    result = client.run("完成父任务")

            result_node = result["childRuns"]["nodes"][0]
            self.assertEqual(result_node["agentName"], "researcher")
            self.assertEqual(result_node["status"], "joined")
            self.assertEqual(result_node["outcome"]["status"], "succeeded")
            self.assertFalse(result_node["recovery"]["resumable"])
            self.assertFalse(result_node["recovery"]["requiresHuman"])

            with tempfile.TemporaryDirectory(prefix="coremind-python-child-v2-") as directory:
                with CoreMindClient(
                    config,
                    protocol_version="2.0",
                    config_dir=directory,
                    cwd=directory,
                    request_timeout=20,
                ) as client:
                    handle = client.run("完成父任务", run_id="python-child-v2")
                    projection = None
                    for _attempt in range(150):
                        try:
                            projection = client.query(handle["runId"])
                        except ProtocolError:
                            time.sleep(0.02)
                            continue
                        if projection["projection"]["status"] == "finished":
                            break
                        time.sleep(0.02)
                    events = client.events(handle["runId"], after_sequence=0, limit=200)

            self.assertIsNotNone(projection)
            projected_node = projection["projection"]["childRuns"]["nodes"][0]
            for field in ("agentName", "status", "outcome"):
                self.assertEqual(projected_node[field], result_node[field])
            for field in ("resumable", "requiresHuman"):
                self.assertEqual(
                    projected_node["recovery"][field], result_node["recovery"][field]
                )
            self.assertEqual(
                projected_node["recovery"]["operation"]["state"],
                result_node["recovery"]["operation"]["state"],
            )
            delegation_events = [
                event for event in events["events"] if event["eventType"] == "fact.delegation"
            ]
            self.assertTrue(delegation_events)
            for event in delegation_events:
                self.assertEqual(event["parentRunId"], handle["runId"])
                self.assertEqual(event["childRunId"], projected_node["childRunId"])
                self.assertEqual(event["delegationId"], projected_node["delegationId"])
        finally:
            mock_server.terminate()
            try:
                mock_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_server.kill()
                mock_server.wait(timeout=2)

    def test_typescript_and_python_share_outcome_and_event_contract(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        bundled_worker = REPOSITORY_ROOT / "python" / "src" / "coremind" / "_worker" / "coremind-worker.mjs"
        self.assertTrue(bundled_worker.is_file(), "请先执行 npm run build:python-worker")
        port = _free_port()
        mock_server = subprocess.Popen(
            [
                node,
                str(REPOSITORY_ROOT / "packages" / "coremind-cli" / "test" / "mock-openai-server.mjs"),
                str(port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
        )
        try:
            _wait_for_port(port)
            base_url = f"http://127.0.0.1:{port}/v1"
            with tempfile.TemporaryDirectory(prefix="coremind-parity-") as directory:
                config = {
                    "schemaVersion": 2,
                    "name": "跨语言一致性测试",
                    "provider": {
                        "id": "probe",
                        "baseUrl": base_url,
                        "model": "probe-model",
                        "apiKeyEnv": "COREMIND_TEST_API_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "测试助手"}},
                }
                with CoreMindClient(
                    config,
                    config_dir=directory,
                    cwd=directory,
                    request_timeout=20,
                ) as client:
                    python_result = client.run("你好")
                    first_chat = client.chat("第一轮")
                    second_chat = client.chat("第二轮")

                completed = subprocess.run(
                    [
                        node,
                        str(Path(__file__).with_name("ts_parity.mjs")),
                        base_url,
                        directory,
                        "你好",
                    ],
                    cwd=REPOSITORY_ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=20,
                )
                typescript_result = json.loads(completed.stdout)

            self.assertEqual(python_result["outcome"], typescript_result["outcome"])
            self.assertEqual(python_result["transcript"], typescript_result["transcript"])
            for result in (python_result, typescript_result):
                self.assertEqual(result["snapshot"]["runId"], result["runId"])
                self.assertEqual(result["snapshot"]["outcome"], result["outcome"])
                self.assertEqual(result["snapshot"]["operation"], result["operation"])
                self.assertEqual(result["snapshot"]["metrics"], result["metrics"])
                self.assertEqual(result["snapshot"]["trace"], result["trace"])
            self.assertEqual(
                set(python_result["snapshot"]), set(typescript_result["snapshot"])
            )
            self.assertEqual(
                [entry["event"]["type"] for entry in python_result["trace"]],
                [entry["event"]["type"] for entry in typescript_result["trace"]],
            )
            self.assertEqual(set(python_result["metrics"]), set(typescript_result["metrics"]))
            self.assertEqual(first_chat["transcript"], "mock回复：第一轮")
            self.assertEqual(second_chat["transcript"], "mock回复：第二轮")
            self.assertGreater(len(second_chat["messages"]["main"]), len(first_chat["messages"]["main"]))
        finally:
            mock_server.terminate()
            try:
                mock_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_server.kill()
                mock_server.wait(timeout=2)

    def test_python_callable_executes_inside_real_node_runtime(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        port = _free_port()
        mock_server = subprocess.Popen(
            [node, str(Path(__file__).with_name("mock_tool_server.mjs")), str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _wait_for_port(port)
            with tempfile.TemporaryDirectory(prefix="coremind-python-tool-") as directory:
                config = {
                    "schemaVersion": 2,
                    "name": "Python 工具测试",
                    "provider": {
                        "id": "probe",
                        "baseUrl": f"http://127.0.0.1:{port}/v1",
                        "model": "probe-model",
                        "apiKeyEnv": "COREMIND_TEST_API_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "调用工具"}},
                    "permissions": {"mode": "ask", "workspaceOnly": True, "network": "ask"},
                }
                with CoreMindClient(
                    config,
                    config_dir=directory,
                    cwd=directory,
                    approval_handler=lambda _request: "allow",
                    request_timeout=20,
                ) as client:

                    @client.tool(
                        description="查询订单",
                        effect={"operations": ["read"], "reversible": True},
                    )
                    def lookup_order(order_id: str) -> dict[str, str]:
                        return {"id": order_id, "status": "paid"}

                    result = client.run("查询订单")

            self.assertEqual(json.loads(result["transcript"]), {"id": "A-1", "status": "paid"})
            self.assertEqual(result["metrics"]["toolCalls"], 1)
        finally:
            mock_server.terminate()
            try:
                mock_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_server.kill()
                mock_server.wait(timeout=2)

    def test_loop_states_and_terminal_result_match_typescript(self) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        port = _free_port()
        mock_server = subprocess.Popen(
            [node, str(Path(__file__).with_name("mock_loop_server.mjs")), str(port)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            _wait_for_port(port)
            base_url = f"http://127.0.0.1:{port}/v1"
            with tempfile.TemporaryDirectory(prefix="coremind-loop-parity-") as directory:
                config = {
                    "schemaVersion": 2,
                    "name": "Loop 跨语言一致性测试",
                    "provider": {
                        "id": "probe",
                        "baseUrl": base_url,
                        "model": "probe-model",
                        "apiKeyEnv": "COREMIND_TEST_API_KEY",
                    },
                    "agents": {
                        "coder": {"systemPrompt": "编码"},
                        "reviewer": {"systemPrompt": "验证"},
                    },
                    "loop": {
                        "execute": {"agent": "coder", "input": "执行 {{prompt}}"},
                        "verify": {
                            "agent": "reviewer",
                            "input": "验证 {{candidate.text}}",
                            "passIf": "{{text}} == PASS",
                        },
                        "repair": {
                            "agent": "coder",
                            "input": "根据 {{verification.text}} 修复",
                        },
                        "maxIterations": 3,
                        "maxRepairs": 2,
                        "maxRepeatedAction": 3,
                    },
                }
                with CoreMindClient(
                    config,
                    config_dir=directory,
                    cwd=directory,
                    request_timeout=20,
                ) as client:
                    python_result = client.run("修复缺陷")

                completed = subprocess.run(
                    [
                        node,
                        str(Path(__file__).with_name("ts_loop_parity.mjs")),
                        base_url,
                        directory,
                    ],
                    cwd=REPOSITORY_ROOT,
                    check=True,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=20,
                )
                typescript_result = json.loads(completed.stdout)

            python_states = [
                entry["event"]["to"]
                for entry in python_result["trace"]
                if entry["event"]["type"] == "loop_state"
            ]
            typescript_states = [
                entry["event"]["to"]
                for entry in typescript_result["trace"]
                if entry["event"]["type"] == "loop_state"
            ]
            self.assertEqual(python_result["outcome"], typescript_result["outcome"])
            self.assertEqual(python_result["transcript"], "candidate-b")
            self.assertEqual(python_result["transcript"], typescript_result["transcript"])
            self.assertEqual(
                python_states,
                ["executing", "verifying", "repairing", "verifying", "succeeded"],
            )
            self.assertEqual(python_states, typescript_states)
        finally:
            mock_server.terminate()
            try:
                mock_server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                mock_server.kill()
                mock_server.wait(timeout=2)


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _wait_for_port(port: int) -> None:
    for _attempt in range(100):
        with socket.socket() as probe:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.02)
    raise RuntimeError("mock server 启动超时")


def _delegation_config(port: int) -> dict[str, object]:
    fixture = (
        REPOSITORY_ROOT
        / "packages"
        / "coremind-cli"
        / "test"
        / "mock-delegation-config.json"
    )
    config: dict[str, object] = json.loads(fixture.read_text(encoding="utf-8"))
    provider = config["provider"]
    if not isinstance(provider, dict):
        raise AssertionError("Child Run fixture provider 必须是对象")
    provider["baseUrl"] = f"http://127.0.0.1:{port}/v1"
    return config


if __name__ == "__main__":
    unittest.main()
