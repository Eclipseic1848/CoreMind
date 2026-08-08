from __future__ import annotations

import json
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from coremind import CoreMindClient


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]


class NodeRuntimeParityTest(unittest.TestCase):
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
                        "apiKey": "test-key",
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
                        "apiKey": "test-key",
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

                    @client.tool(description="查询订单")
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


if __name__ == "__main__":
    unittest.main()
