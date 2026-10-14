from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Thread
from unittest.mock import patch

import coremind
from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError


class RuntimeControlsTest(unittest.TestCase):
    def test_real_sync_and_async_steering_and_follow_up(self) -> None:
        for asynchronous in (False, True):
            for kind in ("steering", "follow_up"):
                with self.subTest(asynchronous=asynchronous, kind=kind):
                    asyncio.run(self.check_control(asynchronous, kind, cancelled=False))

    def test_cancel_discards_unconsumed_control_without_leaking_to_next_run(self) -> None:
        for asynchronous in (False, True):
            with self.subTest(asynchronous=asynchronous):
                asyncio.run(self.check_control(asynchronous, "follow_up", cancelled=True))

    async def check_control(self, asynchronous: bool, kind: str, *, cancelled: bool) -> None:
        requests: list[dict] = []
        errors: list[Exception] = []
        entered, release, cancel_applied = Event(), Event(), Event()

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                ordinal = 0
                try:
                    request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    requests.append(request)
                    ordinal = len(requests)
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    self.wfile.flush()
                    if ordinal == 1:
                        entered.set()
                        if not release.wait(10):
                            raise AssertionError("未释放真实模型响应阶段")
                    for delta, reason in (({"role": "assistant", "content": "当前请求完成"}, None), ({}, "stop")):
                        chunk = {"id": f"control-{ordinal}", "choices": [{"index": 0, "delta": delta, "finish_reason": reason}]}
                        self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError) as error:
                    # 仅忽略首请求在取消已确认后关闭连接；其余请求的连接异常仍是失败。
                    if not (ordinal == 1 and cancel_applied.is_set()):
                        errors.append(error)
                except Exception as error:
                    errors.append(error)

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        model.daemon_threads = True
        server_thread = Thread(target=model.serve_forever, daemon=True)
        server_thread.start()
        process = None
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-python-control-") as directory, \
                    patch.dict(os.environ, {"COREMIND_TEST_API_KEY": "test-only"}):
                os.environ.pop("COREMIND_WORKER_PATH", None)
                config = {
                    "schemaVersion": 2,
                    "name": "Python 真实运行中控制",
                    "provider": {"id": "probe", "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                                 "model": "probe-model", "apiKeyEnv": "COREMIND_TEST_API_KEY"},
                    "agents": {"main": {}},
                    "runtime": {"maxTurns": 4, "maxRetries": 0, "runTimeoutMs": 15_000},
                }
                client = (AsyncCoreMindClient if asynchronous else CoreMindClient)(
                    config, protocol_version="2.0", config_dir=directory, cwd=directory,
                    request_timeout=20,
                )

                async def invoke(method: str, *args, **kwargs):
                    result = getattr(client, method)(*args, **kwargs)
                    return await result if asynchronous else result

                run_id = "python-control-primary"
                control_id = "python-control-once"
                text = f"只交付一次的控制正文-{kind}"
                command = {"schemaVersion": 1, "runId": run_id, "controlId": control_id,
                           "type": kind, "message": text}
                try:
                    handle = await invoke("chat", "原始输入", run_id=run_id)
                    self.assertEqual(handle["runId"], run_id)
                    self.assertTrue(await asyncio.to_thread(entered.wait, 10), "真实模型请求未开始")
                    sync_client = client.sync_client if asynchronous else client
                    process = sync_client._process
                    self.assertIsNotNone(process)
                    self.assertEqual(Path(process.args[1]).resolve(),
                                     Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs")
                    with self.assertRaises(ProtocolError):
                        await invoke("control", {**command, "runId": "wrong-active-run"})
                    receipt = await invoke("control", command)
                    self.assertEqual(receipt["status"], "applied")
                    duplicate = await invoke("control", command)
                    self.assertEqual((duplicate["status"], duplicate["duplicateOf"]), ("duplicate", "applied"))
                    conflict = await invoke("control", {**command, "message": "冲突正文不得交付"})
                    self.assertEqual(conflict["status"], "conflict")
                    self.assertEqual(len(requests), 1)
                    if cancelled:
                        cancel_receipt = await invoke("control", {
                            "schemaVersion": 1, "runId": run_id,
                            "controlId": "python-confirmed-cancel", "type": "cancel",
                        })
                        self.assertEqual(cancel_receipt["status"], "applied")
                        cancel_applied.set()
                    release.set()
                    events = await self.read_finished(invoke, run_id)
                    terminal = events[-1]
                    self.assertEqual(terminal["eventType"], "fact.finish")
                    self.assertEqual(terminal["payload"]["outcome"]["status"], "aborted" if cancelled else "succeeded")
                    identity = "control:" + hashlib.sha256(json.dumps([run_id, control_id], ensure_ascii=False,
                                                                       separators=(",", ":")).encode("utf-8")).hexdigest()
                    inputs = [event for event in events if event["payload"].get("inputId") == identity]
                    self.assertEqual([event["eventType"] for event in inputs],
                                     ["input_receipt", "input_discarded"] if cancelled else
                                     ["input_receipt", "input_claimed", "input_completed"])
                    states = [event["payload"]["state"] for event in events if event["eventType"] == "fact.control"
                              and event["payload"]["controlId"] == control_id]
                    self.assertEqual(states, ["accepted", "applied"])
                    self.assertFalse(any(event["eventType"] == "quiescence_timeout" for event in events))
                    if not cancelled:
                        claimed = next(event for event in inputs if event["eventType"] == "input_claimed")
                        self.assertTrue(any(event["eventType"] == "turn_end" and
                                            event["payload"]["turnId"] == claimed["payload"]["turnId"]
                                            for event in events))
                        self.assertEqual(user_texts(requests[1]).count(text), 1)
                    with self.assertRaises(ProtocolError) as finished:
                        await invoke("resume_run", run_id)
                    self.assertEqual(finished.exception.coremind_code, "run_id_conflict")
                    next_id = "python-control-next"
                    await invoke("run", "下一 Run 的独立输入", run_id=next_id)
                    next_events = await self.read_finished(invoke, next_id)
                    self.assertEqual(next_events[-1]["payload"]["outcome"]["status"], "succeeded")
                    self.assertIs(sync_client._process, process)
                    self.assertIsNone(process.poll())
                    self.assertEqual(len(requests), 2 if cancelled else 3)
                    self.assertEqual(user_texts(requests[-1]), ["下一 Run 的独立输入"])
                    self.assertFalse(any(event["eventType"] == "fact.control" for event in next_events))
                    self.assertFalse(any("冲突正文不得交付" in request_text(request) for request in requests))
                    self.assertEqual(errors, [])
                finally:
                    release.set()
                    await invoke("close")
                self.assertEqual(process.returncode, 0)
                self.assertTrue(process.stdin.closed)
        finally:
            release.set()
            model.shutdown()
            model.server_close()
            server_thread.join(timeout=5)
            self.assertFalse(server_thread.is_alive())

    async def read_finished(self, invoke, run_id: str) -> list[dict]:
        events: list[dict] = []
        cursor = 0
        deadline = time.monotonic() + 20
        while True:
            page = await invoke("events", run_id, after_sequence=cursor, limit=100)
            events.extend(page["events"])
            cursor = page["nextCursor"]
            self.assertLess(time.monotonic(), deadline, "控制 Run 未形成持久终态")
            if any(event["eventType"] == "fact.finish" for event in page["events"]):
                self.assertEqual([event["sequence"] for event in events], list(range(1, cursor + 1)))
                self.assertEqual(len({event["eventId"] for event in events}), len(events))
                return events


def message_text(message: dict) -> str:
    value = message.get("content", "")
    return value if isinstance(value, str) else "".join(part["text"] for part in value if part.get("type") == "text")


def user_texts(request: dict) -> list[str]:
    return [message_text(message) for message in request["messages"] if message["role"] == "user"]


def request_text(request: dict) -> str:
    return "\n".join(message_text(message) for message in request["messages"])


if __name__ == "__main__":
    unittest.main()
