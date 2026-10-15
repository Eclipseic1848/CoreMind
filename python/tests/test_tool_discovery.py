from __future__ import annotations

import asyncio
import copy
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import coremind
from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError


CONTENT = "工具发现真实文件正文-739027"
PRIVATE_FIELDS = ("toolDiscoveryCatalog", "toolDiscoverySelection", "toolDiscoverySearch", "toolDiscoveryContinuations")


class ToolDiscoveryTest(unittest.TestCase):
    def test_sync_v1_bundled_worker_allows_and_denies_deferred_read(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=False, protocol="1.0", denied=denied))

    def test_sync_v2_bundled_worker_allows_and_denies_deferred_read(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=False, protocol="2.0", denied=denied))

    def test_async_v2_bundled_worker_allows_and_denies_deferred_read(self) -> None:
        for denied in (False, True):
            with self.subTest(denied=denied):
                asyncio.run(self._check(asynchronous=True, protocol="2.0", denied=denied))

    def test_cold_worker_reprojects_same_facts_then_new_run_starts_without_activation(self) -> None:
        # 此格证明同事实冷读取与新 Run 隔离；中断后的 execution resume 由 Runtime 验收覆盖。
        asyncio.run(self._check(asynchronous=True, protocol="2.0", denied=False, cold=True))

    def test_new_worker_resumes_installed_read_with_same_config_and_rejects_changed_config(self) -> None:
        asyncio.run(self._check(asynchronous=True, protocol="2.0", denied=True, cold=True, resume=True))

    async def _check(self, *, asynchronous: bool, protocol: str, denied: bool, cold: bool = False, resume: bool = False) -> None:
        requests = []
        failures = []
        phase = {"resume": False, "index": 0, "denied": denied}
        test = self

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(body)
                    ordinal = phase["index"] + (1 if phase["resume"] else 0)
                    phase["index"] += 1
                    names = [tool["function"]["name"] for tool in body.get("tools", [])]
                    if ordinal == 0:
                        test.assertEqual(names, ["discover_tools"])
                        reply = ("discover_tools", {"query": "read", "limit": 5})
                    elif ordinal == 1:
                        test.assertEqual(set(names), {"discover_tools", "read"})
                        declaration = next(tool["function"] for tool in body["tools"] if tool["function"]["name"] == "read")
                        test.assertIn("path", declaration["parameters"]["properties"])
                        test.assertNotIn(CONTENT, json.dumps(body["messages"], ensure_ascii=False))
                        reply = ("read", {"path": "notes.txt"})
                    else:
                        test.assertFalse(phase["denied"], "拒绝 read 后不得发出第三个模型请求")
                        tool_messages = [message for message in body["messages"] if message.get("role") == "tool"]
                        test.assertIn(CONTENT, json.dumps(tool_messages, ensure_ascii=False))
                        reply = None
                    if reply is None:
                        delta = {"role": "assistant", "content": "读取完成"}
                    else:
                        delta = {"role": "assistant", "tool_calls": [{
                            "index": 0, "id": f"discovery-{len(requests)}", "type": "function",
                            "function": {"name": reply[0], "arguments": json.dumps(reply[1], ensure_ascii=False)},
                        }]}
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for content, reason in ((delta, None), ({}, "stop" if reply is None else "tool_calls")):
                        chunk = {"id": f"discovery-model-{len(requests)}", "choices": [{
                            "index": 0, "delta": content, "finish_reason": reason,
                        }]}
                        self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except Exception as error:
                    failures.append(error)
                    self.send_error(500)

            def log_message(self, *_args):
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        model.daemon_threads = True
        thread = threading.Thread(target=model.serve_forever, daemon=True)
        thread.start()
        clients = []
        temporary = None
        try:
            temporary = tempfile.TemporaryDirectory(prefix="coremind-python-discovery-")
            with patch.dict(os.environ, {"COREMIND_TEST_API_KEY": "offline-test-only"}):
                os.environ.pop("COREMIND_WORKER_PATH", None)
                directory = Path(temporary.name)
                (directory / "notes.txt").write_text(CONTENT, encoding="utf-8")
                config = {
                    "schemaVersion": 3, "name": "Python 工具发现真实验收",
                    "provider": {"id": "discovery-probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                 "model": "probe", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                    "agents": {"main": {"tools": [{"id": "read", "exposure": "deferred"}]}},
                    "permissions": {"mode": "ask" if denied else "full", "workspaceOnly": True,
                                    "network": "deny", "allow": ["discover_tools"], "deny": []},
                    "runtime": {"maxTurns": 5, "maxToolCalls": 8, "maxRetries": 0,
                                "maxTokens": 8000, "runTimeoutMs": 15_000},
                }

                def create_client(*, config_value=None, decision=None):
                    client = (AsyncCoreMindClient if asynchronous else CoreMindClient)(
                        config if config_value is None else config_value,
                        protocol_version=protocol, config_dir=directory, cwd=directory, request_timeout=25,
                        approval_handler=(lambda _request: decision) if decision is not None else None,
                    )
                    clients.append(client)
                    return client

                client = create_client(decision="deny" if denied else None)
                await self._invoke(client, asynchronous, "start")
                process = self._process(client, asynchronous)
                await self._run_and_check(client, asynchronous, protocol, denied, "discovery-primary", directory)
                self.assertEqual(len(requests), 2 if denied else 3)
                self.assertEqual(failures, [])
                raw_file = directory / ".coremind" / "runs" / "discovery-primary.jsonl"
                original = raw_file.read_bytes()
                if cold:
                    before_query = await self._invoke(client, asynchronous, "query", "discovery-primary")
                    before_events = await self._finished(client, asynchronous, "discovery-primary")
                    await self._close_clean(client, asynchronous)
                    if resume:
                        changed = copy.deepcopy(config)
                        changed["permissions"]["mode"] = "full"
                        wrong = create_client(config_value=changed, decision="allow")
                        await self._invoke(wrong, asynchronous, "start")
                        with self.assertRaises(ProtocolError) as caught:
                            await self._invoke(wrong, asynchronous, "resume_run", "discovery-primary")
                        self.assertEqual(caught.exception.coremind_code, "resume_config_mismatch")
                        await self._close_clean(wrong, asynchronous)
                        self.assertEqual(len(requests), 2)
                        self.assertEqual(raw_file.read_bytes(), original)
                    client = create_client(decision="allow" if resume else None)
                    await self._invoke(client, asynchronous, "start")
                    replacement = self._process(client, asynchronous)
                    self.assertIsNot(replacement, process)
                    self.assertNotEqual(replacement.pid, process.pid)
                    self.assertEqual(await self._invoke(client, asynchronous, "query", "discovery-primary"), before_query)
                    self.assertEqual(await self._finished(client, asynchronous, "discovery-primary"), before_events)
                    self.assertEqual(len(requests), 2 if resume else 3, "冷读取不得调用 Provider")
                    self.assertEqual(raw_file.read_bytes(), original, "冷投影不得改写权威事实")
                    if resume:
                        phase.update(resume=True, index=0, denied=False)
                        await self._invoke(client, asynchronous, "resume_run", "discovery-primary")
                        resumed = await self._finished(client, asynchronous, "discovery-primary", after_sequence=before_events[-1]["sequence"])
                        projection = (await self._invoke(client, asynchronous, "query", "discovery-primary"))["projection"]
                        self.assertEqual(projection["outcome"]["status"], "succeeded", projection["outcome"])
                        self.assertEqual(len(requests), 4)
                        self.assertEqual({tool["function"]["name"] for tool in requests[2]["tools"]}, {"read", "discover_tools"})
                        self.assertFalse(any(item["eventType"] == "tool_call" and item["payload"].get("tool") == "discover_tools" for item in resumed))
                        prior_records = [json.loads(line) for line in original.decode("utf-8").splitlines()]
                        previous_selection = next(record["payload"]["toolDiscoverySelection"] for record in reversed(prior_records)
                                                  if "toolDiscoverySelection" in record["payload"])
                        summaries = [item["payload"]["toolDiscovery"] for item in resumed if item["eventType"] == "provider_request"]
                        self.assertEqual([item["generation"] for item in summaries], [1, 1])
                        self.assertTrue(all(item["selectionFingerprint"] == previous_selection["fingerprint"] for item in summaries))
                        resumed_bytes = raw_file.read_bytes()
                        self.assertTrue(resumed_bytes.startswith(original), "恢复只能追加原事实，不得改写冻结前缀")
                        resumed_records = [json.loads(line) for line in resumed_bytes.decode("utf-8").splitlines()]
                        self.assertEqual(sum("toolDiscoveryCatalog" in record["payload"] for record in resumed_records), 1)
                        for field in PRIVATE_FIELDS:
                            self.assertNotIn(field, json.dumps({"events": resumed, "projection": projection}, ensure_ascii=False))
                        original = resumed_bytes
                    phase.update(resume=False, index=0, denied=False)
                    await self._run_and_check(client, asynchronous, protocol, False, "discovery-next", directory)
                    self.assertEqual(len(requests), 7 if resume else 6)
                    self.assertEqual(raw_file.read_bytes(), original)
                await self._close_clean(client, asynchronous)
                self.assertEqual(failures, [])
        finally:
            for client in clients:
                await self._invoke(client, asynchronous, "close")
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            if temporary is not None:
                temporary.cleanup()

    async def _run_and_check(self, client, asynchronous, protocol, denied, run_id, directory):
        result = await self._invoke(client, asynchronous, "run", "发现并读取 notes.txt", run_id=run_id)
        if protocol == "2.0":
            events = await self._finished(client, asynchronous, run_id)
            projection = (await self._invoke(client, asynchronous, "query", run_id))["projection"]
            outcome = projection["outcome"]
            trace = projection["trace"]
            public = {"events": events, "projection": projection}
        else:
            outcome, trace = result["outcome"], result["trace"]
            public = {"result": result, "projection": await self._invoke(client, asynchronous, "inspect_run", run_id)}
        self.assertEqual(outcome["status"], "paused" if denied else "succeeded", outcome)
        if denied:
            self.assertEqual(outcome["finishReason"], "tool_approval_denied")
            self.assertTrue(any(entry["event"]["type"] == "policy_denied" and entry["event"].get("tool") == "read" for entry in trace))
            self.assertFalse(any(entry["event"]["type"] == "tool_result" and entry["event"].get("tool") == "read"
                                 and not entry["event"].get("isError") for entry in trace))
        prefixes = [entry["event"]["toolDiscovery"] for entry in trace
                    if entry["event"]["type"] == "context_prefix" and "toolDiscovery" in entry["event"]]
        provider = [entry["event"]["toolDiscovery"] for entry in trace if entry["event"]["type"] == "provider_request"]
        self.assertEqual([item["generation"] for item in prefixes], [0, 1])
        self.assertEqual([item["toolCount"] for item in prefixes], [1, 2])
        self.assertEqual([item["generation"] for item in provider], [0, 1] if denied else [0, 1, 1])
        by_fingerprint = {item["selectionFingerprint"]: item for item in prefixes}
        for item in provider:
            self.assertEqual(item, by_fingerprint[item["selectionFingerprint"]])
            self.assertEqual(set(item), {"version", "catalogFingerprint", "generation", "selectionFingerprint", "toolCount"})
        raw = [json.loads(line) for line in (directory / ".coremind" / "runs" / f"{run_id}.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(sum("toolDiscoveryCatalog" in fact["payload"] for fact in raw), 1)
        selections = [fact["payload"]["toolDiscoverySelection"] for fact in raw if "toolDiscoverySelection" in fact["payload"]]
        self.assertEqual([item["generation"] for item in selections], [0, 1])
        self.assertEqual(sum("toolDiscoverySearch" in fact["payload"] for fact in raw), 1)
        for field in PRIVATE_FIELDS:
            self.assertNotIn(field, json.dumps(public, ensure_ascii=False))

    async def _finished(self, client, asynchronous, run_id, *, after_sequence=0):
        events, cursor = [], after_sequence
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            page = await self._invoke(client, asynchronous, "events", run_id, after_sequence=cursor)
            events.extend(page["events"])
            cursor = page["nextCursor"]
            if any(event["eventType"] in {"fact.finish", "fact.pause"} for event in page["events"]):
                self.assertEqual([event["sequence"] for event in events], list(range(after_sequence + 1, cursor + 1)))
                self.assertEqual(len({event["eventId"] for event in events}), len(events))
                return events
            await asyncio.sleep(0.02)
        self.fail("工具发现业务 Run 未形成持久终态")

    def _process(self, client, asynchronous):
        sync = client.sync_client if asynchronous else client
        process = sync._process
        self.assertIsNotNone(process)
        self.assertEqual(Path(process.args[1]).resolve(), Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs")
        return process

    async def _close_clean(self, client, asynchronous):
        process = self._process(client, asynchronous)
        with patch.object(process, "terminate", wraps=process.terminate) as terminate, patch.object(process, "kill", wraps=process.kill) as kill:
            await self._invoke(client, asynchronous, "close")
            self.assertEqual(process.returncode, 0)
            terminate.assert_not_called()
            kill.assert_not_called()
        for stream in (process.stdin, process.stdout, process.stderr):
            self.assertTrue(stream.closed)
        sync = client.sync_client if asynchronous else client
        self.assertFalse(sync._reader.is_alive())
        self.assertFalse(sync._stderr_reader.is_alive())

    async def _invoke(self, client, asynchronous, method, *args, **kwargs):
        value = getattr(client, method)(*args, **kwargs)
        return await value if asynchronous else value


if __name__ == "__main__":
    unittest.main()
