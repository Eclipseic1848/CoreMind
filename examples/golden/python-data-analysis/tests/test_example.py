"""Python 数据分析黄金示例的纯函数与真实 worker 集成测试。"""

from __future__ import annotations

import importlib.util
import json
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from coremind import CoreMindClient


EXAMPLE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = EXAMPLE_ROOT.parents[2]


def _load_example_module():
    spec = importlib.util.spec_from_file_location(
        "coremind_golden_data_analysis", EXAMPLE_ROOT / "src" / "main.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("无法加载 Python 黄金示例")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PythonDataAnalysisGoldenTest(unittest.TestCase):
    def test_deterministic_csv_analysis_writes_workspace_artifact(self) -> None:
        module = _load_example_module()
        with tempfile.TemporaryDirectory(prefix="coremind-golden-data-") as directory:
            root = Path(directory)
            (root / "data").mkdir()
            shutil.copyfile(EXAMPLE_ROOT / "data" / "sales.csv", root / "data" / "sales.csv")

            result = module.analyze_sales_file("data/sales.csv", root)

            self.assertEqual(result["rows"], 3)
            self.assertEqual(result["total"], 300)
            saved = json.loads((root / "artifacts" / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(saved, result)

    @mock.patch.dict("os.environ", {"GOLDEN_MOCK_API_KEY": "test-only"})
    def test_callable_runs_through_real_node_worker(self) -> None:
        module = _load_example_module()
        node = shutil.which("node")
        self.assertIsNotNone(node, "测试需要 Node.js")
        worker = REPOSITORY_ROOT / "python" / "src" / "coremind" / "_worker" / "coremind-worker.mjs"
        self.assertTrue(worker.is_file(), "请先执行 npm run build:python-worker")
        port = _free_port()
        server = subprocess.Popen(
            [
                node,
                str(REPOSITORY_ROOT / "examples" / "golden" / "_shared" / "mock-provider.mjs"),
                "data",
                str(port),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
        )
        try:
            _wait_for_port(port)
            with tempfile.TemporaryDirectory(prefix="coremind-golden-worker-") as directory:
                root = Path(directory)
                (root / "data").mkdir()
                shutil.copyfile(EXAMPLE_ROOT / "data" / "sales.csv", root / "data" / "sales.csv")
                config = {
                    "schemaVersion": 2,
                    "name": "python-data-analysis-test",
                    "provider": {
                        "id": "golden-data",
                        "baseUrl": f"http://127.0.0.1:{port}/v1",
                        "model": "golden-mock",
                        "apiKeyEnv": "GOLDEN_MOCK_API_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "调用 analyze_sales"}},
                    "runtime": {"maxToolCalls": 1, "maxToolFailures": 0},
                    "permissions": {"mode": "ask", "workspaceOnly": True, "network": "deny"},
                }
                client = CoreMindClient(
                    config,
                    config_dir=root,
                    cwd=root,
                    approval_handler=lambda request: (
                        "allow" if request["tool"] == "analyze_sales" else "deny"
                    ),
                    request_timeout=20,
                )
                module.register_tools(client, root)
                with client:
                    result = client.run("分析 data/sales.csv")

            output = json.loads(result["transcript"])
            self.assertEqual(output["rows"], 3)
            self.assertEqual(output["total"], 300)
            self.assertEqual(result["metrics"]["toolCalls"], 1)
            self.assertEqual(len(result["checkpoints"]), 2)
            self.assertEqual(
                [Path(checkpoint["targetPath"]).name for checkpoint in result["checkpoints"]],
                ["sales.csv", "summary.json"],
            )
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=2)


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
    raise RuntimeError("mock Provider 启动超时")


if __name__ == "__main__":
    unittest.main()
