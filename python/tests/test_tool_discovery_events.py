from __future__ import annotations

import copy
import unittest

from coremind import CoreMindClient, ProtocolError
from coremind.client import _validate_events_page, _validate_query_result, _validate_run_result


SUMMARY = {
    "version": 1, "catalogFingerprint": "catalog-fingerprint", "generation": 0,
    "selectionFingerprint": "selection-fingerprint", "toolCount": 1,
}


def event(summary=SUMMARY) -> dict:
    result = {"type": "context_prefix", "agent": "main", "fingerprint": "prefix-fingerprint"}
    if summary is not None:
        result["toolDiscovery"] = copy.deepcopy(summary)
    return result


def page(payload: dict) -> dict:
    return {
        "schemaVersion": 1, "runId": "discovery", "nextCursor": 1, "hasMore": False,
        "events": [{"eventType": "context_prefix", "payload": payload}],
    }


class ToolDiscoveryEventsTest(unittest.TestCase):
    def test_provider_request_uses_same_closed_summary(self) -> None:
        payload = {"type": "provider_request", "toolSchemaFingerprint": "schema", "toolDiscovery": SUMMARY}
        value = page(payload)
        value["events"][0]["eventType"] = "provider_request"
        self.assertEqual(_validate_events_page(value, "discovery"), value)
        malformed = {**payload, "toolDiscovery": {**SUMMARY, "schema": "private-provider-schema-canary"}}
        with self.assertRaises(ProtocolError):
            _validate_events_page(page(malformed), "discovery")
        client = CoreMindClient({})
        client._handle_notification({"method": "event", "params": {"event": malformed}})
        self.assertEqual(client.received_events, [])
        self.assertNotIn("private-provider-schema-canary", "\n".join(client._stderr_tail))

    def test_old_and_new_event_summary_pass_without_rewriting(self) -> None:
        for payload in (event(None), event()):
            value = page(payload)
            self.assertEqual(_validate_events_page(value, "discovery"), value)
            client = CoreMindClient({})
            notification = {"jsonrpc": "2.0", "method": "event", "params": {"event": payload}}
            client._handle_notification(notification)
            self.assertEqual(client.received_events, [notification["params"]])

    def test_malformed_and_expanded_summary_is_rejected_without_echoing_values(self) -> None:
        malformed = [
            {**SUMMARY, "version": True}, {**SUMMARY, "version": 2},
            {**SUMMARY, "generation": True}, {**SUMMARY, "generation": -1},
            {**SUMMARY, "generation": 0.5}, {**SUMMARY, "toolCount": True},
            {**SUMMARY, "toolCount": -1}, {**SUMMARY, "catalogFingerprint": 1},
            {**SUMMARY, "selectionFingerprint": None},
            {**SUMMARY, "tools": [{"name": "private-directory-canary"}]},
            {key: value for key, value in SUMMARY.items() if key != "toolCount"},
            None,
        ]
        for summary in malformed:
            with self.subTest(summary=summary):
                payload = {**event(None), "toolDiscovery": summary}
                with self.assertRaises(ProtocolError) as caught:
                    _validate_events_page(page(payload), "discovery")
                self.assertEqual(caught.exception.coremind_code, "protocol_validation_failed")
                self.assertNotIn("private-directory-canary", str(caught.exception))
                client = CoreMindClient({})
                client._handle_notification({"method": "event", "params": {"event": payload}})
                self.assertEqual(client.received_events, [])
                self.assertNotIn("private-directory-canary", "\n".join(client._stderr_tail))

    def test_query_and_run_trace_keep_summary_but_reject_private_schema(self) -> None:
        for summary, valid in ((SUMMARY, True), ({**SUMMARY, "schema": {"private": "private-schema-canary"}}, False)):
            with self.subTest(valid=valid):
                trace = [{"event": event(summary)}]
                query = {"schemaVersion": 1, "runId": "discovery", "derivedFromSequence": 1,
                         "projection": {"trace": trace}}
                snapshot = {
                    "schemaVersion": 1, "runId": "discovery", "operation": {}, "outcome": {},
                    "metrics": {}, "evaluation": {}, "releaseReadiness": {}, "trace": trace,
                    "checkpoints": [], "artifacts": [], "extensions": [], "resumable": False,
                }
                result = {"runId": "discovery", "outcome": {}, "trace": trace, "snapshot": snapshot}
                if valid:
                    self.assertEqual(_validate_query_result(query, "discovery"), query)
                    self.assertEqual(_validate_run_result(result), result)
                else:
                    for check in (lambda: _validate_query_result(query, "discovery"), lambda: _validate_run_result(result)):
                        with self.assertRaises(ProtocolError) as caught:
                            check()
                        self.assertNotIn("private-schema-canary", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
