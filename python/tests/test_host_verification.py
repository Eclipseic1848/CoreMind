"""真实 Python SDK 与捆绑 Worker 的宿主验收；模型仅访问 localhost 替身。"""

from __future__ import annotations

import hashlib
import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from coremind import CoreMindClient, ProtocolError


class HostVerificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="coremind-python-host-")
        self.addCleanup(self.directory.cleanup)
        self.key = patch.dict("os.environ", {"COREMIND_HOST_TEST_KEY": "localhost-only"})
        self.key.start()
        self.addCleanup(self.key.stop)
        self.candidates = ["初稿", "修正稿"]
        self.model_requests: list[dict] = []
        fixture = self

        class ModelHandler(BaseHTTPRequestHandler):
            def log_message(self, _format: str, *args: object) -> None:
                pass

            def do_POST(self) -> None:
                body = self.rfile.read(int(self.headers["Content-Length"]))
                fixture.model_requests.append(json.loads(body.decode("utf-8")))
                index = len(fixture.model_requests) - 1
                if index >= len(fixture.candidates):
                    self.send_error(500, "unexpected model request")
                    return
                choices = [
                    {"index": 0, "delta": {"role": "assistant", "content": fixture.candidates[index]},
                     "finish_reason": None},
                    {"index": 0, "delta": {}, "finish_reason": "stop"},
                ]
                data = "".join("data: " + json.dumps({"id": "local-host-test", "choices": [choice]},
                                                     ensure_ascii=False) + "\n\n" for choice in choices)
                encoded = (data + "data: [DONE]\n\n").encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        self.server.daemon_threads = True
        self.server_thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.server_thread.start()
        self.addCleanup(self._close_server)

    def _close_server(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(timeout=5)

    def _client(self, timeout_ms: int = 5000) -> CoreMindClient:
        config = {
            "schemaVersion": 2,
            "name": "Python 宿主验收",
            "provider": {"id": "local-host-test", "model": "local-host-test",
                         "baseUrl": f"http://127.0.0.1:{self.server.server_port}/v1",
                         "apiKeyEnv": "COREMIND_HOST_TEST_KEY"},
            "agents": {"worker": {"systemPrompt": "按请求生成候选"}},
            "loop": {
                "execute": {"agent": "worker", "input": "{{prompt}}"},
                "verify": {"mode": "host", "timeoutMs": timeout_ms},
                "repair": {"agent": "worker", "input": "按宿主反馈修正：{{verification.text}}"},
                "maxIterations": 2, "maxRepairs": 1,
            },
        }
        client = CoreMindClient(config, protocol_version="2.0", config_dir=self.directory.name,
                                cwd=self.directory.name, request_timeout=5)
        self.addCleanup(client.close)
        return client.start()

    def _request(self, client: CoreMindClient, index: int = 0) -> dict:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if len(client.received_verification_requests) > index:
                return dict(client.received_verification_requests[index])
            time.sleep(0.01)
        self.fail("未在 10 秒内收到宿主验收请求")

    def _terminal(self, client: CoreMindClient, run_id: str) -> dict:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                projection = client.query(run_id)["projection"]
            except ProtocolError as error:
                if error.coremind_code != "unknown_run":
                    raise
            else:
                if projection["status"] in {"finished", "paused"}:
                    return projection
            time.sleep(0.02)
        self.fail("未在 10 秒内查询到持久终态或暂停态")

    def test_reject_repair_accept_same_run_with_identity_and_duplicate_checks(self) -> None:
        client = self._client()
        handle = client.run("交付结果", run_id="python-host-repair")
        first = self._request(client)
        self.assertIn("verification", handle["availableControls"])
        self.assertEqual(first["runId"], handle["runId"])
        self.assertEqual(first["candidate"], "初稿")
        self.assertEqual(first["candidateSha256"], hashlib.sha256("初稿".encode("utf-8")).hexdigest())
        self.assertTrue(first["stepId"])
        self.assertEqual(first["iteration"], 1)
        bad_digest = client.submit_verification(first["runId"], first["requestId"], "0" * 64,
                                                decision="accept", control_id="wrong-digest")
        self.assertEqual(bad_digest["status"], "rejected")
        bad_request = client.submit_verification(first["runId"], "unknown-request", first["candidateSha256"],
                                                 decision="accept", control_id="wrong-request")
        self.assertEqual(bad_request["status"], "rejected")
        reply = {"run_id": first["runId"], "request_id": first["requestId"],
                 "candidate_sha256": first["candidateSha256"], "decision": "reject",
                 "feedback": "补充独立证据", "control_id": "reject-draft"}
        self.assertEqual(client.submit_verification(**reply)["status"], "applied")
        self.assertEqual(client.submit_verification(**reply)["status"], "duplicate")
        self.assertEqual(client.submit_verification(**{**reply, "decision": "accept"})["status"], "conflict")
        second = self._request(client, 1)
        self.assertEqual(second["runId"], first["runId"])
        self.assertNotEqual(second["requestId"], first["requestId"])
        self.assertEqual(second["iteration"], 2)
        self.assertEqual(second["candidate"], "修正稿")
        client.submit_verification(second["runId"], second["requestId"], second["candidateSha256"],
                                   decision="accept", control_id="accept-revised")
        terminal = self._terminal(client, first["runId"])
        self.assertEqual(terminal["outcome"]["status"], "succeeded")
        self.assertEqual(len(self.model_requests), 2)
        self.assertIn("补充独立证据", json.dumps(self.model_requests[1], ensure_ascii=False))

    def test_cancel_waiting_gate_rejects_late_acceptance(self) -> None:
        client = self._client()
        client.run("等待验收", run_id="python-host-cancel")
        request = self._request(client)
        client.cancel(request["runId"])
        terminal = self._terminal(client, request["runId"])
        self.assertEqual(terminal["outcome"]["status"], "aborted")
        with self.assertRaises(ProtocolError):
            client.submit_verification(request["runId"], request["requestId"], request["candidateSha256"],
                                       decision="accept", control_id="late-accept")
        self.assertEqual(self._terminal(client, request["runId"])["outcome"]["status"], "aborted")
        self.assertEqual(len(self.model_requests), 1)

    def test_unknown_pauses_then_new_client_resumes_same_request_without_model_replay(self) -> None:
        first_client = self._client(timeout_ms=1000)
        first_client.run("等待宿主恢复", run_id="python-host-resume")
        original = self._request(first_client)
        paused = self._terminal(first_client, original["runId"])
        self.assertEqual(paused["outcome"]["status"], "paused")
        first_client.close()
        resumed_client = self._client(timeout_ms=1000)
        resumed_client.resume_run(original["runId"])
        recovered = self._request(resumed_client)
        self.assertEqual(recovered, original)
        resumed_client.submit_verification(recovered["runId"], recovered["requestId"],
                                            recovered["candidateSha256"], decision="accept", control_id="after-restart")
        terminal = self._terminal(resumed_client, original["runId"])
        self.assertEqual(terminal["outcome"]["status"], "succeeded")
        self.assertEqual(len(self.model_requests), 1)


if __name__ == "__main__":
    unittest.main()
