from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from coremind import CoreMindClient, ProtocolError


CHALLENGE = {
    "schemaVersion": 1,
    "requiredCapabilities": ["toolDiscovery"],
    "retryInitialize": True,
}

# 复用既有协议夹具，仅在真实 JSONL 通道上注入初始化响应并记录请求。
# 该测试不证明真实 Worker 的配置校验或工具发现实现。
WORKER_WRAPPER = r'''
import json
import os
import runpy
import sys
from pathlib import Path

fixture, record_path, scenario_json = sys.argv[1:]
scenario = json.loads(scenario_json)
original_input, original_output = sys.stdin, sys.stdout
state = {"initializations": 0, "initialize_id": None}

def record(value):
    with Path(record_path).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps({"pid": os.getpid(), **value}, ensure_ascii=False) + "\n")

def respond(value):
    record({"kind": "response", "message": value})
    original_output.write(json.dumps(value, ensure_ascii=False) + "\n")
    original_output.flush()

class RecordedInput:
    def __getattr__(self, name):
        return getattr(original_input, name)

    def __iter__(self):
        return self

    def __next__(self):
        while True:
            line = original_input.readline()
            if not line:
                raise StopIteration
            message = json.loads(line)
            record({"kind": "request", "message": message})
            if message["method"] == "initialize":
                state["initializations"] += 1
                state["initialize_id"] = message["id"]
                mode = scenario.get("mode", "plain")
                if mode in ("reject", "repeat") or (mode == "challenge" and state["initializations"] == 1):
                    respond({"jsonrpc": "2.0", "id": message["id"], "error": scenario["error"]})
                    continue
            return line

class RecordedOutput:
    def __getattr__(self, name):
        return getattr(original_output, name)

    def write(self, value):
        message = json.loads(value)
        if message.get("id") == state["initialize_id"] and "result" in message:
            result = message["result"]
            key = "serverCapabilities" if "selectedProtocol" in result else "capabilities"
            if scenario.get("advertise", False) and "toolDiscovery" not in result[key]:
                result[key] = [*result[key], "toolDiscovery"]
            if scenario.get("omit_discovery_receipt", False):
                result[key] = [capability for capability in result[key] if capability != "toolDiscovery"]
        record({"kind": "response", "message": message})
        original_output.write(json.dumps(message, ensure_ascii=False) + "\n")
        return len(value)

record({"kind": "boot"})
sys.stdin, sys.stdout = RecordedInput(), RecordedOutput()
try:
    runpy.run_path(fixture, run_name="__main__")
finally:
    record({"kind": "exit"})
'''


def challenge_error(details=CHALLENGE, *, code="protocol_capability_missing") -> dict:
    return {
        "code": -32000,
        "message": "初始化缺少工具发现能力",
        "data": {"coremindCode": code, "details": copy.deepcopy(details)},
    }


class ToolDiscoveryProtocolTest(unittest.TestCase):
    def _config(self, directory: Path, kind: str, *, deferred: bool = True):
        config = {
            "schemaVersion": 3 if deferred else 2,
            "name": "tool-discovery",
            "agents": {"main": {"tools": [{"id": "read", **({"exposure": "deferred"} if deferred else {})}]}},
        }
        if kind == "mapping":
            return config
        path = directory / f"config.{kind}"
        if kind == "json":
            path.write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        else:
            path.write_text(
                f"schemaVersion: {config['schemaVersion']}\nname: tool-discovery\nagents:\n  main:\n    tools:\n      - id: read\n"
                + ("        exposure: deferred\n" if deferred else ""),
                encoding="utf-8",
            )
        return path

    @contextmanager
    def _worker(self, directory: Path, scenario: dict, *, config=None, protocol="1.0"):
        records = directory / "wire.jsonl"
        processes = []
        real_popen = subprocess.Popen

        def spawn(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            processes.append(process)
            return process

        client = CoreMindClient(
            config if config is not None else self._config(directory, "mapping"),
            config_dir=directory,
            cwd=directory,
            session_id="discovery-session",
            protocol_version=protocol,
            request_timeout=3,
            worker_command=[
                sys.executable, "-u", "-c", WORKER_WRAPPER,
                str(Path(__file__).with_name("fake_worker.py").resolve()),
                str(records), json.dumps(scenario, ensure_ascii=False),
            ],
        )
        # Popen 仍启动真实进程；仅保存句柄以检查失败路径的回收。
        with patch("coremind.client.subprocess.Popen", side_effect=spawn):
            try:
                yield client, records
            finally:
                client.close()
                self.assertEqual(len(processes), 1, "不得另外启动配置解析进程")
                for process in processes:
                    self.assertEqual(process.wait(timeout=2), 0, "夹具须沿关闭或 EOF 自然退出")
                    for stream in (process.stdin, process.stdout, process.stderr):
                        self.assertTrue(stream is not None and stream.closed)
                for thread in (client._reader, client._stderr_reader):
                    self.assertTrue(thread is not None and not thread.is_alive())

    def _initializations(self, records: Path) -> list[dict]:
        rows = [json.loads(line) for line in records.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sum(row["kind"] == "boot" for row in rows), 1)
        self.assertEqual(sum(row["kind"] == "exit" for row in rows), 1)
        self.assertEqual(len({row["pid"] for row in rows}), 1)
        requests = [row["message"] for row in rows if row["kind"] == "request"]
        self.assertTrue(all(request["method"] in {"initialize", "close"} for request in requests))
        return [request for request in requests if request["method"] == "initialize"]

    def _legacy_params(self, config, directory: Path) -> dict:
        params = {
            "protocolVersion": "1.0", "configDir": str(directory),
            "cwd": str(directory), "sessionId": "discovery-session",
        }
        params["config" if isinstance(config, dict) else "configPath"] = config if isinstance(config, dict) else str(config)
        return params

    def test_plain_v1_preserves_first_packet_for_mapping_json_and_yaml(self) -> None:
        for kind in ("mapping", "json", "yaml"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve()
                config = self._config(directory, kind, deferred=False)
                original = copy.deepcopy(config)
                with self._worker(directory, {}, config=config) as (client, records):
                    client.start()
                    client.start()
                requests = self._initializations(records)
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0]["params"], self._legacy_params(config, directory))
                self.assertNotIn("capabilities", requests[0]["params"])
                self.assertEqual(config, original)

    def test_exact_v1_challenge_retries_once_in_same_process_for_all_config_forms(self) -> None:
        for kind in ("mapping", "json", "yaml"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve()
                config = self._config(directory, kind)
                with self._worker(directory, {"mode": "challenge", "error": challenge_error(), "advertise": True}, config=config) as (client, records):
                    client.start()
                    client.start()
                requests = self._initializations(records)
                self.assertEqual(len(requests), 2)
                self.assertNotEqual(requests[0]["id"], requests[1]["id"])
                self.assertEqual(requests[0]["params"], self._legacy_params(config, directory))
                self.assertEqual(requests[1]["params"], {**requests[0]["params"], "capabilities": ["toolDiscovery"]})

    def test_repeated_challenge_is_rejected_after_exactly_one_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            with self._worker(directory, {"mode": "repeat", "error": challenge_error()}) as (client, records):
                with self.assertRaises(ProtocolError) as caught:
                    client.start()
            self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")
            self.assertEqual(len(self._initializations(records)), 2)

    def test_ordinary_errors_do_not_trigger_retry_even_with_challenge_details(self) -> None:
        for code in ("invalid_config", "internal_error"):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve()
                with self._worker(directory, {"mode": "reject", "error": challenge_error(code=code)}) as (client, records):
                    with self.assertRaises(ProtocolError):
                        client.start()
                self.assertEqual(len(self._initializations(records)), 1)

    def test_malformed_or_expanded_challenges_do_not_trigger_retry(self) -> None:
        malformed = [
            None, {}, [],
            {**CHALLENGE, "schemaVersion": True},
            {**CHALLENGE, "schemaVersion": 2},
            {**CHALLENGE, "requiredCapabilities": "toolDiscovery"},
            {**CHALLENGE, "requiredCapabilities": []},
            {**CHALLENGE, "requiredCapabilities": ["toolDiscovery", "mcpAuthentication"]},
            {**CHALLENGE, "requiredCapabilities": ["toolDiscovery", "toolDiscovery"]},
            {**CHALLENGE, "retryInitialize": 1},
            {**CHALLENGE, "retryInitialize": False},
            {**CHALLENGE, "unexpected": True},
            {key: value for key, value in CHALLENGE.items() if key != "schemaVersion"},
        ]
        for details in malformed:
            with self.subTest(details=details), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary).resolve()
                with self._worker(directory, {"mode": "reject", "error": challenge_error(details)}) as (client, records):
                    with self.assertRaises(ProtocolError):
                        client.start()
                self.assertEqual(len(self._initializations(records)), 1)

    def test_retry_without_capability_receipt_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            with self._worker(directory, {"mode": "challenge", "error": challenge_error()}) as (client, records):
                with self.assertRaises(ProtocolError) as caught:
                    client.start()
            self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")
            self.assertEqual(len(self._initializations(records)), 2)

    def test_v2_fingerprint_mismatch_never_retries_or_downgrades(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            config = self._config(directory, "mapping")
            config["name"] = "bad-fingerprint"
            with self._worker(directory, {"advertise": True}, config=config, protocol="2.0") as (client, records):
                with self.assertRaises(ProtocolError) as caught:
                    client.start()
            self.assertEqual(caught.exception.coremind_code, "protocol_version_mismatch")
            requests = self._initializations(records)
            self.assertEqual(len(requests), 1)
            self.assertIn("protocolRange", requests[0]["params"])
            self.assertNotIn("protocolVersion", requests[0]["params"])

    def test_v2_never_uses_v1_capability_challenge_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            with self._worker(directory, {"mode": "reject", "error": challenge_error()}, protocol="2.0") as (client, records):
                with self.assertRaises(ProtocolError) as caught:
                    client.start()
            self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")
            requests = self._initializations(records)
            self.assertEqual(len(requests), 1)
            self.assertIn("protocolRange", requests[0]["params"])
            self.assertNotIn("protocolVersion", requests[0]["params"])

    def test_v2_declares_discovery_and_requires_its_receipt_without_retry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            with self._worker(directory, {"omit_discovery_receipt": True}, protocol="2.0") as (client, records):
                with self.assertRaises(ProtocolError) as caught:
                    client.start()
            self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")
            requests = self._initializations(records)
            self.assertEqual(len(requests), 1)
            self.assertIn("toolDiscovery", requests[0]["params"]["capabilities"])
            self.assertIn("protocolRange", requests[0]["params"])
            self.assertNotIn("protocolVersion", requests[0]["params"])

    def test_v2_matching_fingerprint_and_discovery_receipt_start_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary).resolve()
            with self._worker(directory, {}, protocol="2.0") as (client, records):
                client.start()
                client.start()
            requests = self._initializations(records)
            self.assertEqual(len(requests), 1)
            self.assertIn("toolDiscovery", requests[0]["params"]["capabilities"])


if __name__ == "__main__":
    unittest.main()
