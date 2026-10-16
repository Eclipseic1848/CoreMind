from __future__ import annotations

import asyncio
import hashlib
import queue
import threading
import unittest
from unittest.mock import patch

import coremind.client as sdk
from coremind import AsyncCoreMindClient, CoreMindClient, NotificationHistory


BUCKETS = {"events": "received_events", "tool_calls": "received_tool_calls",
           "tool_cancellations": "received_tool_cancellations",
           "verification_requests": "received_verification_requests"}


def notification(bucket: str, index: int) -> dict:
    identity = {"schemaVersion": 1, "runId": f"run-{index % 3}", "callId": f"call-{index}",
                "registrationId": "registration-1", "toolId": "tool-1"}
    if bucket == "events":
        return {"method": "event", "params": {"runId": identity["runId"], "sequence": index,
                "event": {"type": "agent_start", "agent": "main", "eventId": f"event-{index}"}}}
    if bucket == "tool_calls":
        method, params = "tool_call", {**identity, "name": "lookup",
                "argumentsFingerprint": "sha256:" + "a" * 64, "args": {"index": index}}
    elif bucket == "tool_cancellations":
        method, params = "tool_cancel", {**identity, "reason": "aborted"}
    else:
        candidate = f"候选-{index}"
        method, params = "verification_request", {
            "schemaVersion": 1, "runId": identity["runId"], "requestId": f"request-{index}",
            "stepId": "step-1", "iteration": 1, "candidate": candidate,
            "candidateSha256": hashlib.sha256(candidate.encode("utf-8")).hexdigest(),
        }
    return {"jsonrpc": "2.0", "protocolVersion": "2.0", "method": method, "params": params}


def client() -> CoreMindClient:
    result = CoreMindClient({"schemaVersion": 2, "name": "history", "agents": {"main": {}}},
                            protocol_version="2.0")
    result._capabilities = frozenset({"hostVerification"})
    return result


class NotificationHistoryTest(unittest.TestCase):
    def test_default_retention_shallow_copy_identity_and_validation_outside_lock(self) -> None:
        current = client()
        expected = {}
        validators = {"events": "_validate_tool_discovery_summary", "tool_calls": "_validate_tool_call",
                      "tool_cancellations": "_validate_tool_cancel", "verification_requests": "parse_verification_request"}
        with patch("coremind.client.subprocess.Popen") as spawn:
            for bucket, attribute in BUCKETS.items():
                real = getattr(sdk, validators[bucket])
                def validate(value, real=real):
                    acquired = current._pending_lock.acquire(blocking=False)
                    self.assertTrue(acquired, "验证必须在历史短锁外")
                    if acquired:
                        current._pending_lock.release()
                    return real(value)
                with patch.object(sdk, validators[bucket], side_effect=validate):
                    for index in (0, 1):
                        current._handle_notification(notification(bucket, index))
                expected[bucket] = list(getattr(current, attribute))
                self.assertEqual(len(expected[bucket]), 2)
            invalid = notification("tool_calls", 2)
            invalid["params"]["unknown"] = True
            current._handle_notification(invalid)
            invalid = notification("tool_cancellations", 2)
            invalid["params"]["reason"] = "unknown"
            current._handle_notification(invalid)
            invalid = notification("verification_requests", 2)
            invalid["params"]["candidateSha256"] = "a" * 64
            current._handle_notification(invalid)
            current._handle_notification({"method": "event", "params": {"event": {
                "type": "context_prefix", "toolDiscovery": {},
            }}})
            references = {bucket: getattr(current, attribute) for bucket, attribute in BUCKETS.items()}
            batch: NotificationHistory = current.drain_notifications()
            self.assertEqual(batch, expected)
            self.assertEqual(set(batch), set(NotificationHistory.__required_keys__))
            for bucket, attribute in BUCKETS.items():
                self.assertIs(getattr(current, attribute), references[bucket])
                self.assertEqual(references[bucket], [])
                self.assertIsNot(batch[bucket], references[bucket])
                self.assertIs(batch[bucket][0], expected[bucket][0])
            self.assertTrue(all(not values for values in current.drain_notifications().values()))
            current._handle_notification(notification("events", 3))
            current.close()
            self.assertEqual(len(current.drain_notifications()["events"]), 1)
            spawn.assert_not_called()

    def test_copy_failure_keeps_all_four_original_lists(self) -> None:
        current = client()
        for bucket in BUCKETS:
            current._handle_notification(notification(bucket, 0))
        class FailingCopy(list):
            def __iter__(self):
                raise MemoryError("复制失败")
        current.received_verification_requests = FailingCopy(current.received_verification_requests)
        references = {bucket: getattr(current, attribute) for bucket, attribute in BUCKETS.items()}
        with self.assertRaises(MemoryError):
            current.drain_notifications()
        for bucket, attribute in BUCKETS.items():
            self.assertIs(getattr(current, attribute), references[bucket])
            self.assertEqual(len(references[bucket]), 1)

    def test_producer_and_two_consumers_have_no_duplicate_or_lost_notifications(self) -> None:
        current = client()
        start = threading.Barrier(4)
        batches, errors = queue.Queue(), queue.Queue()
        def execute(action):
            try:
                start.wait(timeout=2)
                action()
            except BaseException as error:
                errors.put(error)
        def produce():
            for index in range(100):
                for bucket in BUCKETS:
                    current._handle_notification(notification(bucket, index))
        def consume():
            for _ in range(200):
                batches.put(current.drain_notifications())
        threads = [threading.Thread(target=execute, args=(action,), daemon=True)
                   for action in (produce, consume, consume)]
        ready = False
        try:
            for thread in threads:
                thread.start()
            start.wait(timeout=2)
            ready = True
        finally:
            if not ready:
                start.abort()
            for thread in threads:
                thread.join(timeout=3)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        if not errors.empty():
            raise errors.get_nowait()
        batches.put(current.drain_notifications())
        received = {bucket: [] for bucket in BUCKETS}
        while not batches.empty():
            batch = batches.get_nowait()
            for bucket, values in batch.items():
                received[bucket].extend(values)
        for bucket, values in received.items():
            if bucket == "events":
                indices = [value["sequence"] for value in values]
            elif bucket == "verification_requests":
                indices = [int(value["requestId"].split("-")[-1]) for value in values]
            else:
                indices = [int(value["callId"].split("-")[-1]) for value in values]
            self.assertEqual(sorted(indices), list(range(100)), bucket)

    def test_each_producer_waits_until_the_atomic_four_bucket_copy_and_clear_finishes(self) -> None:
        def exercise(chosen):
            current = client()
            for bucket in BUCKETS:
                current._handle_notification(notification(bucket, 0))
            copied, release, attempted, produced = (threading.Event() for _ in range(4))
            errors, batches = queue.Queue(), queue.Queue()
            class CopyGate(list):
                def __iter__(self):
                    snapshot = tuple(super().__iter__())
                    copied.set()
                    if not release.wait(2):
                        raise AssertionError("复制 gate 未释放")
                    return iter(snapshot)
            class ObservedLock:
                def __enter__(self):
                    if threading.current_thread().name == "history-producer":
                        attempted.set()
                    original_lock.acquire()
                def __exit__(self, *_args):
                    original_lock.release()
            original_lock = current._pending_lock
            current._pending_lock = ObservedLock()
            current.received_verification_requests = CopyGate(current.received_verification_requests)
            references = {bucket: getattr(current, attribute) for bucket, attribute in BUCKETS.items()}
            def drain():
                try:
                    batches.put(current.drain_notifications())
                except BaseException as error:
                    errors.put(error)
            def produce():
                try:
                    current._handle_notification(notification(chosen, 1))
                    produced.set()
                except BaseException as error:
                    errors.put(error)
            reader = threading.Thread(target=drain, daemon=True)
            producer = threading.Thread(target=produce, name="history-producer", daemon=True)
            try:
                reader.start()
                self.assertTrue(copied.wait(2))
                producer.start()
                self.assertTrue(attempted.wait(2), "producer 必须实际到达同一短锁")
                self.assertFalse(produced.is_set(), "复制/清空之间的新 append 必须等锁")
            finally:
                release.set()
                for thread in (reader, producer):
                    if thread.ident is not None:
                        thread.join(timeout=2)
            self.assertFalse(reader.is_alive())
            self.assertFalse(producer.is_alive())
            if not errors.empty():
                raise errors.get_nowait()
            first, second = batches.get_nowait(), current.drain_notifications()
            self.assertEqual([len(first[bucket]) for bucket in BUCKETS], [1] * 4)
            self.assertEqual([len(second[bucket]) for bucket in BUCKETS],
                             [int(bucket == chosen) for bucket in BUCKETS])
            for bucket, attribute in BUCKETS.items():
                self.assertIs(getattr(current, attribute), references[bucket])
        for chosen in BUCKETS:
            with self.subTest(bucket=chosen):
                exercise(chosen)

    def test_approval_handler_can_drain_without_blocking_its_original_response(self) -> None:
        retained, threads = [], []
        errors = queue.Queue()
        def approve(_event):
            try:
                retained.append(current.drain_notifications())
                return "deny"
            except BaseException as error:
                errors.put(error)
                return "deny"
        current = CoreMindClient({"schemaVersion": 2, "name": "approval-history", "agents": {"main": {}}},
                                 approval_handler=approve)
        original_thread = threading.Thread
        def spawn(*args, **kwargs):
            thread = original_thread(*args, **kwargs)
            threads.append(thread)
            return thread
        with patch.object(current, "_request_raw", return_value={"accepted": True}) as request, \
             patch("coremind.client.threading.Thread", side_effect=spawn), \
             patch("coremind.client.subprocess.Popen") as process:
            current._handle_notification({"method": "event", "params": {
                "runId": "approval-run", "event": {"type": "approval_required", "approvalId": "approval-1"},
            }})
            for thread in threads:
                thread.join(timeout=2)
            self.assertEqual(len(threads), 1)
            self.assertTrue(all(not thread.is_alive() for thread in threads))
            if not errors.empty():
                raise errors.get_nowait()
            self.assertEqual(len(retained[0]["events"]), 1)
            self.assertTrue(all(not values for values in current.drain_notifications().values()))
            request.assert_called_once_with("approve", {"runId": "approval-run", "approvalId": "approval-1", "decision": "deny"})
            process.assert_not_called()

    def test_async_local_drain_has_no_background_cancellation_window(self) -> None:
        async def exercise():
            current = AsyncCoreMindClient({"schemaVersion": 2, "name": "async-history", "agents": {"main": {}}})
            current.sync_client._handle_notification(notification("events", 0))
            cancelled = asyncio.create_task(current.drain_notifications())
            cancelled.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await cancelled
            self.assertEqual(len(current.sync_client.received_events), 1)
            with patch("asyncio.to_thread", side_effect=AssertionError("drain 不应交给后台线程")), \
                 patch("coremind.client.subprocess.Popen") as spawn:
                batch = await current.drain_notifications()
                self.assertEqual([event["sequence"] for event in batch["events"]], [0])
                self.assertTrue(all(not values for values in (await current.drain_notifications()).values()))
                spawn.assert_not_called()
            await current.close()
        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
