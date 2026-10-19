from __future__ import annotations

import asyncio
from contextlib import contextmanager, redirect_stderr
from io import StringIO
import json
import os
import queue
import subprocess
import sys
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

from coremind import AsyncCoreMindClient, CoreMindClient, CoreMindError, ProtocolError


@contextmanager
def _worker_failure_context(client, protocol: str, asynchronous: bool, trusted: bool):
    # 仅记录测试生命周期；失败时也保留 SDK 清空内部引用之前创建的真实进程。
    processes = []
    cleanup = []
    original_popen = subprocess.Popen
    original_cleanup = client._terminate_process
    started = time.monotonic()

    def spawn(*args, **kwargs):
        process = original_popen(*args, **kwargs)
        processes.append(process)
        return process

    def state():
        try:
            process = processes[-1] if processes else None
            return {"pid": process.pid if process else None,
                    "returncode": process.poll() if process else None,
                    "readerAlive": bool(client._reader and client._reader.is_alive()),
                    "stderrReaderAlive": bool(client._stderr_reader and client._stderr_reader.is_alive())}
        except Exception:
            return {"unavailable": True}

    def terminate():
        record = {"before": state()}
        if len(cleanup) < 2:
            cleanup.append(record)
        try:
            return original_cleanup()
        finally:
            record["after"] = state()

    with patch("coremind.client.subprocess.Popen", side_effect=spawn), \
         patch.object(client, "_terminate_process", side_effect=terminate):
        try:
            yield processes
        except BaseException:
            # 不输出配置、环境、命令、路径或原始 stderr；观测失败不能替代原异常。
            try:
                evidence = {"protocol": protocol, "asynchronous": asynchronous, "trusted": trusted,
                            "elapsedMs": round((time.monotonic() - started) * 1000),
                            "processCount": len(processes), "state": state(), "cleanup": cleanup}
                print("COREMIND_TEST_WORKER_FAILURE " + json.dumps(evidence, separators=(",", ":")),
                      file=sys.stderr)
            except Exception:
                pass
            raise


# 复用既有假 Worker 的全部协议形状，仅在真实 JSONL 回执去掉新能力并记录请求。
LEGACY_WRAPPER = r'''
import json, runpy, sys
from pathlib import Path
fixture, record = sys.argv[1:]
original_input, original_output = sys.stdin, sys.stdout
class Input:
    def __getattr__(self, name): return getattr(original_input, name)
    def __iter__(self): return self
    def __next__(self):
        line = original_input.readline()
        if not line: raise StopIteration
        with Path(record).open("a", encoding="utf-8") as output:
            output.write(line)
        return line
class Output:
    def __getattr__(self, name): return getattr(original_output, name)
    def write(self, text):
        message = json.loads(text)
        result = message.get("result")
        if isinstance(result, dict):
            for field in ("capabilities", "serverCapabilities"):
                if field in result:
                    result[field] = [value for value in result[field] if value != "projectCodeTrust"]
        original_output.write(json.dumps(message, ensure_ascii=False) + "\n")
        return len(text)
sys.stdin, sys.stdout = Input(), Output()
runpy.run_path(fixture, run_name="__main__")
'''


class ProjectCodeTrustTest(unittest.TestCase):
    def test_observation_failure_cannot_interrupt_cleanup_or_replace_original_error(self) -> None:
        for broken_output in (False, True):
            with self.subTest(broken_output=broken_output):
                client = CoreMindClient({"schemaVersion": 2, "name": "probe", "agents": {"main": {}}})
                failure = CoreMindError("原异常")
                output = StringIO()
                with patch.object(client, "_reader") as reader, \
                     patch.object(client, "_terminate_process") as cleanup, \
                     patch.object(output, "write", wraps=output.write,
                                  side_effect=RuntimeError("写入失败") if broken_output else None), \
                     redirect_stderr(output):
                    reader.is_alive.side_effect = RuntimeError("观测失败")
                    with self.assertRaises(CoreMindError) as caught:
                        with _worker_failure_context(client, "1.0", False, False):
                            client._terminate_process()
                            raise failure
                self.assertIs(caught.exception, failure)
                cleanup.assert_called_once_with()
                if not broken_output:
                    context = json.loads(output.getvalue().split(" ", 1)[1])
                    self.assertEqual(context["state"], {"unavailable": True})
                    self.assertEqual(context["cleanup"], [{"before": {"unavailable": True},
                                                           "after": {"unavailable": True}}])

    def test_observation_does_not_swallow_cleanup_failure(self) -> None:
        client = CoreMindClient({"schemaVersion": 2, "name": "probe", "agents": {"main": {}}})
        failure = CoreMindError("原清理异常")
        with patch.object(client, "_terminate_process", side_effect=failure), \
             redirect_stderr(StringIO()), self.assertRaises(CoreMindError) as caught:
            with _worker_failure_context(client, "1.0", False, False):
                client._terminate_process()
        self.assertIs(caught.exception, failure)

    def test_initialize_timeout_preserves_failure_context_and_reaps_worker(self) -> None:
        asyncio.run(self._initialize_timeout_matrix())

    async def _initialize_timeout_matrix(self) -> None:
        secret = "must-not-appear-in-failure-context"
        worker = 'import sys; print("must-not-appear-in-failure-context", file=sys.stderr, flush=True); list(sys.stdin)'
        for version in ("1.0", "2.0"):
            for asynchronous in (False, True):
                with self.subTest(version=version, asynchronous=asynchronous):
                    client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
                    client = client_type(
                        {"schemaVersion": 2, "name": secret, "agents": {"main": {}}},
                        protocol_version=version, request_timeout=1,
                        worker_command=[sys.executable, "-u", "-c", worker],
                    )
                    sync = client.sync_client if asynchronous else client
                    output = StringIO()
                    try:
                        with self.assertRaises(CoreMindError) as caught, redirect_stderr(output):
                            with _worker_failure_context(sync, version, asynchronous, False) as processes:
                                try:
                                    if asynchronous:
                                        await client.start()
                                    else:
                                        client.start()
                                finally:
                                    if asynchronous:
                                        await client.close()
                                    else:
                                        client.close()
                    finally:
                        if asynchronous:
                            await client.close()
                        else:
                            client.close()
                    self.assertEqual(str(caught.exception), "协议请求 initialize 超时")
                    self.assertIsInstance(caught.exception.__cause__, queue.Empty)
                    self.assertEqual(len(processes), 1)
                    self.assertIsNone(sync._process)
                    self.assertEqual(processes[0].returncode, 0)
                    self.assertFalse(sync._reader.is_alive())
                    self.assertFalse(sync._stderr_reader.is_alive())
                    lines = output.getvalue().splitlines()
                    self.assertEqual(len(lines), 1)
                    self.assertTrue(lines[0].startswith("COREMIND_TEST_WORKER_FAILURE "))
                    self.assertLessEqual(len(lines[0].encode("utf-8")), 1536)
                    context = json.loads(lines[0].split(" ", 1)[1])
                    self.assertEqual(set(context), {"protocol", "asynchronous", "trusted", "elapsedMs",
                                                    "processCount", "state", "cleanup"})
                    self.assertEqual((context["protocol"], context["asynchronous"], context["trusted"]),
                                     (version, asynchronous, False))
                    self.assertEqual(context["processCount"], 1)
                    self.assertGreater(context["elapsedMs"], 0)
                    self.assertEqual(context["state"], {"pid": processes[0].pid, "returncode": 0,
                                                       "readerAlive": False, "stderrReaderAlive": False})
                    self.assertEqual(len(context["cleanup"]), 2)
                    self.assertIsNone(context["cleanup"][0]["before"]["returncode"])
                    self.assertEqual(context["cleanup"][0]["after"], context["state"])
                    self.assertEqual(context["cleanup"][1], {"before": context["state"],
                                                            "after": context["state"]})
                    self.assertNotIn(secret, output.getvalue())
                    self.assertNotIn(str(Path(__file__).resolve()), output.getvalue())

    def test_boolean_only_and_initialize_field(self) -> None:
        config = {"schemaVersion": 2, "name": "trust", "agents": {"main": {}}}
        with patch("coremind.client.subprocess.Popen") as spawn:
            for client_type in (CoreMindClient, AsyncCoreMindClient):
                for invalid in ("false", "true", 0, 1, None):
                    with self.subTest(client=client_type.__name__, invalid=invalid):
                        with self.assertRaises(TypeError):
                            client_type(config, trust_project_code=invalid)
            spawn.assert_not_called()
        for enabled in (False, True):
            for version in ("1.0", "2.0"):
                client = CoreMindClient(config, trust_project_code=enabled, protocol_version=version)
                params = client._initialize_v2_params() if version == "2.0" else client._initialize_params()
                self.assertEqual(params.get("trustProjectCode", False), enabled)
                if not enabled:
                    self.assertNotIn("trustProjectCode", params)

    def test_old_worker_is_rejected_before_any_run_or_chat(self) -> None:
        for version in ("1.0", "2.0"):
            for asynchronous in (False, True):
                for enabled in (False, True):
                    with self.subTest(version=version, asynchronous=asynchronous, enabled=enabled), \
                         tempfile.TemporaryDirectory(prefix="coremind-legacy-trust-") as temporary:
                        directory = Path(temporary).resolve()
                        records = directory / "wire.jsonl"
                        client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
                        client = client_type(
                            {"schemaVersion": 2, "name": "legacy", "agents": {"main": {}}},
                            config_dir=directory, cwd=directory, protocol_version=version,
                            trust_project_code=enabled, request_timeout=3,
                            worker_command=[sys.executable, "-u", "-c", LEGACY_WRAPPER,
                                            str(Path(__file__).with_name("fake_worker.py")), str(records)],
                        )
                        processes = []
                        original_popen = subprocess.Popen
                        def spawn(*args, **kwargs):
                            process = original_popen(*args, **kwargs)
                            processes.append(process)
                            return process
                        with patch("coremind.client.subprocess.Popen", side_effect=spawn):
                            try:
                                with self.assertRaises(ProtocolError) as caught:
                                    if asynchronous:
                                        asyncio.run(client.chat("不可运行"))
                                    else:
                                        client.run("不可运行")
                                self.assertEqual(caught.exception.coremind_code, "protocol_capability_missing")
                                self.assertIn("projectCodeTrust", str(caught.exception))
                            finally:
                                if asynchronous:
                                    asyncio.run(client.close())
                                else:
                                    client.close()
                        self.assertEqual(len(processes), 1)
                        self.assertEqual(processes[0].wait(timeout=2), 0)
                        messages = [json.loads(line) for line in records.read_text(encoding="utf-8").splitlines()]
                        self.assertEqual([message["method"] for message in messages], ["initialize"])
                        self.assertEqual(messages[0]["params"].get("trustProjectCode", False), enabled)

    def test_real_bundled_worker_requires_explicit_trust_in_both_sdks_and_protocols(self) -> None:
        asyncio.run(self._real_worker_matrix())

    async def _real_worker_matrix(self) -> None:
        requests: list[dict] = []
        class Model(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for delta, finish in (({"role": "assistant", "content": "完成"}, None), ({}, "stop")):
                    message = {"id": "trust", "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(message, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            def log_message(self, _format: str, *_args: object) -> None:
                pass
        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            for version in ("1.0", "2.0"):
                for asynchronous in (False, True):
                    for enabled in (False, True):
                        with self.subTest(version=version, asynchronous=asynchronous, enabled=enabled), \
                             tempfile.TemporaryDirectory(prefix="coremind-bundled-trust-") as temporary:
                            directory = Path(temporary).resolve()
                            (directory / "probe.mjs").write_text('''import {writeFileSync} from "node:fs";
writeFileSync(new URL("./imported",import.meta.url),"loaded","utf8");
export default {name:"project_probe",description:"trust canary",parameters:{type:"object",properties:{}},
execute:async()=>({content:[{type:"text",text:"ok"}],details:{}})};
''', encoding="utf-8")
                            config = {"schemaVersion": 2, "name": "bundled-trust",
                                      "provider": {"id": "trust", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                                   "model": "trust", "apiKeyEnv": "COREMIND_PYTHON_TRUST_TEST_KEY"},
                                      "agents": {"main": {}},
                                      "tools": [{"path": "probe.mjs", "effect": {"operations": ["read"], "reversible": True}}],
                                      "runtime": {"maxRetries": 0, "runTimeoutMs": 5000}}
                            client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
                            client = client_type(config, config_dir=directory, cwd=directory,
                                                 protocol_version=version, trust_project_code=enabled, request_timeout=8)
                            sync = client.sync_client if asynchronous else client
                            before = len(requests)
                            process = None
                            with _worker_failure_context(sync, version, asynchronous, enabled), \
                                 patch.dict(os.environ, {"COREMIND_PYTHON_TRUST_TEST_KEY": "test-only-key"}):
                                os.environ.pop("COREMIND_WORKER_PATH", None)
                                try:
                                    if asynchronous:
                                        await client.start()
                                    else:
                                        client.start()
                                    process = sync._process
                                    self.assertIn("projectCodeTrust", sync._capabilities)
                                    if not enabled and version == "1.0":
                                        with self.assertRaises(ProtocolError) as caught:
                                            if asynchronous:
                                                await client.run("验收")
                                            else:
                                                client.run("验收")
                                        self.assertEqual(caught.exception.coremind_code, "execution_security_violation")
                                    else:
                                        result = await client.run("验收") if asynchronous else client.run("验收")
                                        if version == "2.0":
                                            deadline = time.monotonic() + 5
                                            while True:
                                                result = (await client.query(result["runId"]) if asynchronous
                                                          else client.query(result["runId"]))["projection"]
                                                if result.get("outcome"):
                                                    break
                                                self.assertLess(time.monotonic(), deadline)
                                                await asyncio.sleep(0.01)
                                        self.assertEqual(result["outcome"]["status"], "succeeded" if enabled else "failed")
                                    self.assertEqual((directory / "imported").exists(), enabled)
                                    self.assertEqual(len(requests) - before, 1 if enabled else 0)
                                finally:
                                    if asynchronous:
                                        await client.close()
                                    else:
                                        client.close()
                            self.assertIsNotNone(process)
                            self.assertEqual(process.returncode, 0, "\n".join(sync._stderr_tail))
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
