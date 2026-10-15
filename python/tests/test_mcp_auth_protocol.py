from __future__ import annotations

import asyncio
import json
import queue
import threading
from io import StringIO
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from coremind import AsyncCoreMindClient, CoreMindClient, ProtocolError, parse_mcp_auth_request
from coremind.client import _validate_mcp_auth_result


def notification() -> dict:
    return {
        "jsonrpc": "2.0", "protocolVersion": "2.0", "method": "mcp_auth_request",
        "params": {"schemaVersion": 1, "transactionId": "auth-1", "server": "remote",
                   "serverIdentity": "a" * 64, "authorizationUrl": "https://issuer.example/authorize?state=public&code_challenge=public",
                   "expiresAt": "2030-01-01T00:00:00.000Z", "issuer": "https://issuer.example/",
                   "clientId": "native-client", "resource": "https://mcp.example/rpc", "scopes": ["read"]},
    }


class McpAuthProtocolTest(unittest.TestCase):
    def test_closed_notifications_and_result_do_not_accept_credentials(self) -> None:
        value = notification()
        self.assertEqual(parse_mcp_auth_request(value), value["params"])
        for key in ("token", "refreshToken", "code", "state", "verifier", "unknown"):
            with self.subTest(key=key), self.assertRaises(ProtocolError):
                parse_mcp_auth_request({**value, "params": {**value["params"], key: "private"}})
        request = {"schemaVersion": 1, "action": "login", "server": "remote", "transactionId": "auth-1"}
        result = {**request, "status": "authorized", "serverIdentity": "a" * 64}
        self.assertEqual(_validate_mcp_auth_result(result, request), result)
        for change in ({"status": "failed"}, {"status": "cancelled"}, {"token": "private"}, {"server": "other"}):
            with self.subTest(change=change), self.assertRaises(ProtocolError):
                _validate_mcp_auth_result({**result, **change}, request)

    def test_bad_navigation_is_rejected_without_echoing_raw_value(self) -> None:
        for url in ("file:///secret", "https://user:private@issuer.example/", "https://issuer.example/#private", "https://issuer.example/\nprivate", "https://issuer.example/authorize?access_token=private", "https://issuer.example/authorize?code=private"):
            value = notification()
            value["params"]["authorizationUrl"] = url
            with self.subTest(url=url), self.assertRaises(ProtocolError) as caught:
                parse_mcp_auth_request(value)
            self.assertNotIn("private", str(caught.exception))

    def test_headless_has_no_start_and_reader_only_queues(self) -> None:
        client = CoreMindClient({}, protocol_version="2.0")
        with patch.object(client, "start") as start, self.assertRaises(ProtocolError):
            client.mcp_login("remote")
        start.assert_not_called()
        called = []
        client = CoreMindClient({}, protocol_version="2.0", mcp_auth_handler=lambda request: called.append(request))
        client._capabilities = frozenset({"mcpAuthentication"})
        pending = queue.Queue(maxsize=2)
        client._mcp_auth_waiters["auth-1"] = {"server": "remote", "queue": pending, "notified": False}
        client._handle_notification(notification())
        self.assertEqual(called, [])
        self.assertEqual(pending.get_nowait()["params"]["transactionId"], "auth-1")
        self.assertEqual(client.received_events, [])
        client._handle_notification(notification())
        self.assertIsInstance(pending.get_nowait(), ProtocolError)

    def test_without_capability_no_auth_rpc(self) -> None:
        client = CoreMindClient({}, protocol_version="2.0", mcp_auth_handler=lambda _request: None)
        with patch.object(client, "start"), patch.object(client, "_request_raw") as request:
            with self.assertRaises(ProtocolError):
                client.mcp_login("remote")
            request.assert_not_called()

    def test_duplicate_transaction_failure_does_not_cancel_its_existing_owner(self) -> None:
        client = CoreMindClient({}, protocol_version="2.0", mcp_auth_handler=lambda _request: None)
        client._capabilities = frozenset({"mcpAuthentication"})
        client._process = SimpleNamespace(poll=lambda: None, stdin=StringIO())
        original = {"server": "remote", "queue": queue.Queue(maxsize=2), "notified": False}
        client._mcp_auth_waiters["same-id"] = original
        with patch.object(client, "start"), patch.object(client, "mcp_cancel_auth") as cancel:
            with self.assertRaises(ProtocolError):
                client.mcp_login("remote", transaction_id="same-id")
            cancel.assert_not_called()
        self.assertIs(client._mcp_auth_waiters["same-id"], original)


class McpAuthAsyncOwnershipTest(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_before_async_duplicate_registration_keeps_sync_owner(self) -> None:
        wrapper = AsyncCoreMindClient({}, protocol_version="2.0", mcp_auth_handler=lambda _request: None)
        client = wrapper.sync_client
        client._capabilities = frozenset({"mcpAuthentication"})
        original_started = threading.Event()
        duplicate_entered = threading.Event()
        release_duplicate = threading.Event()
        requests = []
        original_result = []
        original_errors = []

        class WorkerInput(StringIO):
            def write(self, value):
                message = json.loads(value)
                requests.append(message)
                if message["params"]["action"] == "login":
                    original_started.set()
                else:
                    # 使用真实 RPC 发送与取消结果校验，仅替代本测试的 Worker 字节通道。
                    with client._pending_lock:
                        pending = client._pending[message["id"]]
                    pending.put({"jsonrpc": "2.0", "result": {
                        **message["params"], "status": "cancelled",
                    }})
                return len(value)

        stream = WorkerInput()
        client._process = SimpleNamespace(poll=lambda: None, stdin=stream)
        raw_request = client._request_raw

        def original_login():
            try:
                original_result.append(client.mcp_login("remote", transaction_id="same-id"))
            except BaseException as error:
                original_errors.append(error)

        def gated_request(method, params, **kwargs):
            if method == "mcp_auth" and params["action"] == "login":
                duplicate_entered.set()
                if not release_duplicate.wait(5):
                    raise AssertionError("重复调用未释放注册边界")
            return raw_request(method, params, **kwargs)

        owner = threading.Thread(target=original_login)
        duplicate = None
        with patch.object(client, "start", return_value=client), patch.object(wrapper, "start", new=AsyncMock(return_value=wrapper)):
            try:
                owner.start()
                self.assertTrue(await asyncio.to_thread(original_started.wait, 2))
                original = client._mcp_auth_waiters["same-id"]
                with patch.object(client, "_request_raw", side_effect=gated_request):
                    duplicate = asyncio.create_task(wrapper.mcp_login("remote", transaction_id="same-id"))
                    self.assertTrue(await asyncio.to_thread(duplicate_entered.wait, 2))
                    duplicate.cancel()
                    release_duplicate.set()
                    with self.assertRaises(asyncio.CancelledError):
                        await asyncio.wait_for(duplicate, 2)
                self.assertEqual([request["params"]["action"] for request in requests], ["login"])
                self.assertIs(client._mcp_auth_waiters["same-id"], original)
                self.assertTrue(owner.is_alive())
            finally:
                release_duplicate.set()
                if duplicate is not None:
                    if not duplicate.done():
                        duplicate.cancel()
                    await asyncio.gather(duplicate, return_exceptions=True)
                if original_started.is_set():
                    # 原调用必须仍能沿自己的真实响应队列正常完成，而非依靠线程退出兜底。
                    original_request = requests[0]
                    with client._pending_lock:
                        pending = client._pending.get(original_request["id"])
                    if pending is not None:
                        pending.put({"jsonrpc": "2.0", "result": {
                            **original_request["params"], "status": "authorized", "serverIdentity": "a" * 64,
                        }})
                await asyncio.to_thread(owner.join, 2)
                stream.close()
        self.assertFalse(owner.is_alive())
        self.assertEqual(original_errors, [])
        self.assertEqual(original_result[0]["status"], "authorized")
        self.assertEqual(client._mcp_auth_waiters, {})
        self.assertEqual(client._pending, {})


if __name__ == "__main__":
    unittest.main()
