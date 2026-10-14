from __future__ import annotations

import asyncio
import json
import os
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch

import coremind
from coremind import AsyncCoreMindClient, CoreMindClient


REPLIES = ["第1次回复：中文🙂|终点1", "第2次回复：中文🙂|终点2", "第3次回复：中文🙂|终点3"]


class WorkerReuseTest(unittest.TestCase):
    def test_sync_v2_reuses_bundled_worker_for_three_runs(self) -> None:
        self._check_reuse(asynchronous=False)

    def test_async_v2_reuses_bundled_worker_for_three_runs(self) -> None:
        self._check_reuse(asynchronous=True)

    def _check_reuse(self, *, asynchronous: bool) -> None:
        requests: list[dict] = []

        class ModelHandler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                size = int(self.headers["Content-Length"])
                requests.append(json.loads(self.rfile.read(size)))
                ordinal = len(requests)
                reply = REPLIES[ordinal - 1] if ordinal <= 3 else "出现了非预期的额外请求"
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for part, reason in ((reply[:3], None), (reply[3:8], None),
                                     (reply[8:], None), (None, "stop")):
                    delta = {"role": "assistant", "content": part} if part is not None else {}
                    chunk = {
                        "id": f"worker-reuse-{ordinal}",
                        "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
                    }
                    self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()

            def log_message(self, _format: str, *_args: object) -> None:
                pass

        model = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        thread = Thread(target=model.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="coremind-worker-reuse-") as directory:
                workspace = Path(directory)
                config = {
                    "schemaVersion": 2,
                    "name": "常驻 Worker 连续 Run 验收",
                    "provider": {
                        "id": "worker-reuse",
                        "baseUrl": f"http://127.0.0.1:{model.server_port}/v1",
                        "model": "worker-reuse-model",
                        "apiKeyEnv": "COREMIND_WORKER_REUSE_KEY",
                    },
                    "agents": {"main": {"systemPrompt": "返回本轮回复后结束"}},
                    "runtime": {"maxTurns": 2, "maxRetries": 0, "runTimeoutMs": 15_000},
                }
                with patch.dict(os.environ, {"COREMIND_WORKER_REUSE_KEY": "offline-test-only"}):
                    os.environ.pop("COREMIND_WORKER_PATH", None)
                    asyncio.run(self._exercise_client(config, workspace, requests, asynchronous))
        finally:
            model.shutdown()
            model.server_close()
            thread.join(timeout=5)

    async def _exercise_client(
        self, config: dict, workspace: Path, requests: list[dict], asynchronous: bool,
    ) -> None:
        bundled_worker = Path(coremind.__file__).resolve().parent / "_worker" / "coremind-worker.mjs"
        self.assertTrue(bundled_worker.is_file(), "测试需要已经生成的内置 Worker")
        client_type = AsyncCoreMindClient if asynchronous else CoreMindClient
        client = client_type(
            config, protocol_version="2.0", config_dir=workspace, cwd=workspace,
            request_timeout=20,
        )
        if asynchronous:
            await client.start()
        else:
            client.start()
        sync_client = client.sync_client if asynchronous else client
        process = sync_client._process
        self.assertIsNotNone(process)
        self.assertEqual(Path(process.args[1]).resolve(), bundled_worker)
        mode = "async" if asynchronous else "sync"
        completed: list[tuple[str, dict, list[dict]]] = []
        with patch.object(process, "terminate", wraps=process.terminate) as terminate, \
             patch.object(process, "kill", wraps=process.kill) as kill:
            try:
                for ordinal in range(1, 4):
                    run_id = f"worker-reuse-{mode}-{ordinal}"
                    prompt = f"只处理任务-{ordinal}"
                    # 每个新 Run 只调用一次；终态后直接发下一次，不重试 worker_busy。
                    handle = await client.run(prompt, run_id=run_id) if asynchronous else client.run(prompt, run_id=run_id)
                    events = await self._read_finished(client, run_id, asynchronous)
                    completed.append((run_id, handle, events))

                all_event_ids: set[str] = set()
                self.assertEqual(len(requests), 3, "每个新 Run 必须恰好调用一次本地 Provider")
                for ordinal, (run_id, handle, events) in enumerate(completed, 1):
                    self.assertEqual(handle["runId"], run_id)
                    self.assertEqual(handle["selectedProtocol"], "2.0")
                    self.assertIs(sync_client._process, process)
                    self.assertIsNone(process.poll(), "连续 Run 不能通过重启 Worker 完成")
                    self.assertTrue(events)
                    self.assertTrue(all(event["runId"] == run_id for event in events))
                    event_ids = {event["eventId"] for event in events}
                    self.assertEqual(len(event_ids), len(events))
                    self.assertTrue(all_event_ids.isdisjoint(event_ids), "不同 Run 复用了事件身份")
                    all_event_ids.update(event_ids)
                    self.assertEqual([event["sequence"] for event in events], list(range(1, len(events) + 1)))
                    text = "".join(event["payload"]["delta"] for event in events
                                   if event["eventType"] == "text_delta")
                    self.assertEqual(text.encode("utf-8"), REPLIES[ordinal - 1].encode("utf-8"))
                    terminals = [event for event in events if event["eventType"] == "fact.finish"]
                    self.assertEqual(len(terminals), 1)
                    self.assertEqual(terminals[0]["payload"]["outcome"]["status"], "succeeded")
                    projection = (await client.query(run_id) if asynchronous else client.query(run_id))["projection"]
                    self.assertEqual(projection["runId"], run_id)
                    self.assertEqual(projection["status"], "finished")
                    self.assertEqual(projection["outcome"]["status"], "succeeded")
                    users = [message for message in requests[ordinal - 1]["messages"]
                             if message["role"] == "user"]
                    self.assertEqual([_message_text(message) for message in users], [f"只处理任务-{ordinal}"])
            finally:
                if asynchronous:
                    await client.close()
                else:
                    client.close()
            observation = {"pid": process.pid, "returncode": process.returncode,
                           "terminateCalls": terminate.call_count, "killCalls": kill.call_count}
            self.assertEqual(process.returncode, 0, observation)
            self.assertTrue(process.stdin.closed, observation)
            terminate.assert_not_called()
            kill.assert_not_called()

    async def _read_finished(self, client, run_id: str, asynchronous: bool) -> list[dict]:
        events: list[dict] = []
        cursor = 0
        deadline = time.monotonic() + 20
        while True:
            page = (await client.events(run_id, after_sequence=cursor, limit=100)
                    if asynchronous else client.events(run_id, after_sequence=cursor, limit=100))
            events.extend(page["events"])
            cursor = page["nextCursor"]
            if any(event["eventType"] == "fact.finish" for event in page["events"]):
                return events
            self.assertLess(time.monotonic(), deadline, f"Run {run_id} 未形成持久终态")
            if not page["hasMore"]:
                await asyncio.sleep(0.01)


def _message_text(message: dict) -> str:
    content = message["content"]
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in content if part.get("type") == "text")


if __name__ == "__main__":
    unittest.main()
