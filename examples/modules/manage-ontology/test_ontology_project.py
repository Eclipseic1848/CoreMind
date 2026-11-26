import json
import shutil
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from unittest.mock import Mock, patch

from starlette.testclient import TestClient

from ontology_project import OntologyProject, demo_transition
from ontology_server import make_app


MODELS = Path(__file__).parent / "models"
RECORD = {"externalId": "A3", "状态": "R", "克重": 1250, "owner": "urn:person:li"}


class OntologyProjectTest(unittest.TestCase):
    def test_real_model_validation_and_replacement(self):
        documents = OntologyProject(MODELS / "document-review")
        result = documents.describe("urn:doc:guide")
        self.assertIn("urn:review:PolicyDocument", result["types"])
        self.assertIn({"predicate": "urn:review:reviewedBy", "target": "urn:person:li"}, result["relationships"])
        self.assertEqual(documents.validate_record("catalog", RECORD)["status"], "conforms")
        missing = documents.validate_record("catalog", {k: v for k, v in RECORD.items() if k != "owner"})
        self.assertEqual(missing["status"], "violates")
        self.assertTrue(any(item["path"] == "urn:review:reviewedBy" for item in missing["violations"]))
        ambiguous = documents.validate_record("catalog", {**RECORD, "externalId": "A2"})
        self.assertEqual(ambiguous["status"], "needs_confirmation")

        equipment = OntologyProject(MODELS / "equipment-maintenance", demo_transition)
        reader = equipment.describe("urn:equipment:reader")
        self.assertNotEqual(reader["bundleDigest"], result["bundleDigest"])
        self.assertIn("urn:maintenance:Equipment", reader["types"])
        self.assertIn({"predicate": "urn:maintenance:station", "target": "urn:site:north"}, reader["relationships"])
        self.assertEqual(equipment.validate_record(
            "inventory", {"number": "N-2", "state": "FIXED", "site": "urn:site:north"}
        )["status"], "conforms")
        self.assertEqual(equipment.perform_action("restore-service", "urn:equipment:reader", "eq-1")["state"], "online")

    def test_guard_order_effect_readback_and_retry(self):
        executor = Mock(side_effect=demo_transition)
        project = OntologyProject(MODELS / "document-review", executor)
        draft = "urn:doc:draft"
        self.assertEqual(project.perform_action("publish", draft, "p1")["reason"], "precondition_failed")
        executor.assert_not_called()
        self.assertEqual(project.perform_action("review", draft, "r1")["state"], "reviewed")
        self.assertEqual(project.perform_action("publish", draft, "p1")["state"], "published")
        self.assertTrue(project.perform_action("publish", draft, "p1")["replayed"])
        self.assertEqual(project.perform_action("publish", "urn:doc:guide", "p1")["reason"], "request_id_conflict")
        self.assertEqual(executor.call_count, 2)
        self.assertEqual(project.inspect_action("publish", draft)["state"], "published")
        properties = project.describe(draft)["properties"]
        self.assertTrue(any(item["predicate"] == "urn:review:state" and item["value"] == "published" for item in properties))

    def test_missing_receipt_blocks_replay_and_independent_new_request(self):
        executor = Mock(return_value=None)
        project = OntologyProject(MODELS / "document-review", executor)
        action = ("publish", "urn:doc:guide")
        self.assertEqual(project.perform_action(*action, "lose-ack")["status"], "unknown")
        self.assertTrue(project.perform_action(*action, "lose-ack")["replayed"])
        self.assertEqual(project.perform_action(*action, "new-id")["reason"], "prior_effect_unknown")
        executor.assert_called_once()

    def test_confirmed_effect_with_local_projection_failure_stays_unknown(self):
        executor = Mock(side_effect=demo_transition)
        project = OntologyProject(MODELS / "document-review", executor)
        with patch.object(project.graph, "set_state", side_effect=RuntimeError("存储故障")):
            result = project.perform_action("publish", "urn:doc:guide", "p1")
        self.assertEqual((result["status"], result["reason"]), ("unknown", "effect_projection_failed"))
        self.assertEqual(project.perform_action("publish", "urn:doc:guide", "p2")["reason"], "prior_effect_unknown")
        executor.assert_called_once()

    def test_versioned_rules_block_effect_before_call(self):
        with TemporaryDirectory() as temp:
            model = Path(temp) / "model"
            shutil.copytree(MODELS / "document-review", model)
            path = model / "actions.json"
            bindings = json.loads(path.read_text(encoding="utf-8"))
            bindings["modelVersion"] = "2.0.0"
            bindings["actions"]["publish"]["to"] = "invalid-state"
            path.write_text(json.dumps(bindings), encoding="utf-8")
            executor = Mock(side_effect=demo_transition)
            original = OntologyProject(MODELS / "document-review")
            revised = OntologyProject(model, executor)
            self.assertNotEqual(original.identity["bundleDigest"], revised.identity["bundleDigest"])
            result = revised.perform_action("publish", "urn:doc:guide", "p1")
            self.assertEqual((result["modelVersion"], result["status"]), ("2.0.0", "denied"))
            executor.assert_not_called()
            self.assertEqual(original.inspect_action("publish", "urn:doc:guide")["status"], "ready")

    def test_receipt_database_owns_writer_and_persists_confirmed_or_unknown_results(self):
        with TemporaryDirectory() as temp:
            journal = Path(temp) / "receipts.sqlite3"
            first = OntologyProject(MODELS / "document-review", demo_transition, receipt_db=journal)
            try:
                with self.assertRaises(sqlite3.OperationalError):
                    OntologyProject(MODELS / "document-review", demo_transition, receipt_db=journal)
                self.assertEqual(first.perform_action("publish", "urn:doc:guide", "one")["status"], "completed")
                first.executor = Mock(return_value=None)
                self.assertEqual(first.perform_action("review", "urn:doc:draft", "two")["status"], "unknown")
            finally:
                first.close()
            executor = Mock()
            restored = OntologyProject(MODELS / "document-review", executor, receipt_db=journal)
            try:
                self.assertEqual(restored.inspect_action("publish", "urn:doc:guide")["state"], "published")
                self.assertTrue(restored.perform_action("publish", "urn:doc:guide", "one")["replayed"])
                self.assertEqual(restored.perform_action("review", "urn:doc:draft", "two")["status"], "unknown")
                self.assertEqual(restored.perform_action("review", "urn:doc:draft", "three")["reason"], "prior_effect_unknown")
                executor.assert_not_called()
            finally:
                restored.close()


class OntologyReconciliationTest(unittest.TestCase):
    action = "review"
    resource = "urn:doc:draft"
    request_id = "lost-receipt"
    route = "/admin/reconcile-action"
    read_token = "Bearer ontology-read-fixture-0001"
    action_token = "Bearer ontology-action-fixture-0002"
    reconcile_token = "Bearer ontology-reconcile-fixture-0003"

    def setUp(self):
        directory = TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.journal = Path(directory.name) / "action-receipts.sqlite3"
        self.executor = Mock(side_effect=lambda command: (
            None if command["requestId"] == self.request_id else demo_transition(command)
        ))
        self.project = self.open_project()
        self.addCleanup(lambda: self.project.close())
        self.assertEqual(self.perform(self.request_id)["status"], "unknown")

    def open_project(self):
        return OntologyProject(MODELS / "document-review", self.executor, receipt_db=self.journal)

    def reopen(self):
        self.project.close()
        self.project = self.open_project()

    def perform(self, request_id, action=None):
        return self.project.perform_action(action or self.action, self.resource, request_id)

    def receipt(self, **changes):
        return {"requestId": self.request_id, "resource": self.resource, "previousState": "draft",
                "status": "completed", "state": "reviewed", **changes}

    def client(self, project=None):
        return TestClient(make_app(
            project or self.project, self.read_token.encode("utf-8"), self.action_token.encode("utf-8"),
            reconcile_token=self.reconcile_token.encode("utf-8"),
        ), base_url="http://127.0.0.1:8879")

    def post(self, client, body, token=None):
        return client.post(self.route, json=body, headers={"Authorization": token or self.reconcile_token})

    def assert_state(self, value):
        properties = self.project.describe(self.resource)["properties"]
        self.assertEqual([row["value"] for row in properties if row["predicate"] == "urn:review:state"], [value])

    def assert_blocked(self):
        self.assertEqual(self.perform("blocked")["reason"], "prior_effect_unknown")
        self.assertEqual(self.perform(self.request_id)["status"], "unknown")
        self.assert_state("draft")
        self.executor.assert_called_once()

    def test_only_host_can_submit_and_wrong_receipts_preserve_the_block(self):
        with self.client() as client:
            self.assertEqual(client.post(self.route, json=self.receipt()).status_code, 401)
            for token in (self.read_token, self.action_token, "Bearer unrelated"):
                self.assertEqual(self.post(client, self.receipt(), token).status_code, 401)
            self.assertEqual(client.get("/health", headers={"Authorization": self.reconcile_token}).status_code, 401)
            invalid_json = client.post(self.route, content="{", headers={
                "Content-Type": "application/json", "Authorization": self.reconcile_token,
            })
            self.assertEqual(invalid_json.status_code, 400)
            for body in ({"requestId": self.request_id}, self.receipt(status="unknown"), self.receipt(extra=True)):
                self.assertEqual(self.post(client, body).status_code, 400)
            self.assertEqual(self.post(client, self.receipt(requestId="not-reserved")).status_code, 404)
            for body in (
                self.receipt(resource="urn:doc:guide"), self.receipt(previousState="reviewed"),
                self.receipt(state="published"), self.receipt(status="failed", state="reviewed"),
            ):
                with self.subTest(body=body):
                    self.assertEqual(self.post(client, body).status_code, 409)
                    self.assert_blocked()
        without_journal = OntologyProject(MODELS / "document-review")
        self.addCleanup(without_journal.close)
        with self.client(without_journal) as client:
            self.assertEqual(self.post(client, self.receipt()).status_code, 503)

    def test_concurrent_confirmations_are_idempotent_and_old_receipt_cannot_rewind(self):
        self.reopen()
        reached_commit, release_commit = Event(), Event()
        persist = self.project._journal.reconcile

        def wait_at_commit(previous, result):
            reached_commit.set()
            self.assertTrue(release_commit.wait(10))
            return persist(previous, result)

        with self.client() as client, ThreadPoolExecutor(max_workers=3) as pool, patch.object(
            self.project._journal, "reconcile", side_effect=wait_at_commit,
        ) as cas:
            initial = pool.submit(self.post, client, self.receipt())
            try:
                self.assertTrue(reached_commit.wait(10))
                repeat = pool.submit(self.post, client, self.receipt())
                disputed = pool.submit(self.post, client, self.receipt(status="failed", state="draft"))
            finally:
                release_commit.set()
            first, duplicate, conflict = [task.result(timeout=10) for task in (initial, repeat, disputed)]
            cas.assert_called_once()
        self.assertEqual([first.status_code, duplicate.status_code, conflict.status_code], [200, 200, 409])
        self.assertEqual(first.json()["status"], "completed")
        self.assertEqual(duplicate.json(), {**first.json(), "replayed": True})
        self.assertEqual(duplicate.json(), self.perform(self.request_id))
        self.executor.assert_called_once()
        self.reopen()
        self.assert_state("reviewed")
        self.assertEqual(self.perform(self.request_id)["state"], "reviewed")
        self.assertEqual(self.perform("next-action", "publish")["state"], "published")
        replay = self.project.reconcile_action(self.receipt())
        self.assertEqual((replay["replayed"], replay["state"]), (True, "reviewed"))
        self.assert_state("published")
        self.reopen()
        self.assert_state("published")
        self.assertEqual(self.executor.call_count, 2)

    def test_confirmed_failure_allows_new_request_without_reexecuting_original(self):
        failed = self.receipt(status="failed", state="draft")
        self.assertEqual(self.project.reconcile_action(failed)["status"], "failed")
        self.executor.assert_called_once()
        self.reopen()
        self.assert_state("draft")
        self.assertEqual(self.perform(self.request_id)["status"], "failed")
        self.assertEqual(self.perform("next-action")["status"], "completed")
        replay = self.project.reconcile_action(failed)
        self.assertEqual((replay["replayed"], replay["state"]), (True, "draft"))
        self.assert_state("reviewed")
        self.reopen()
        self.assert_state("reviewed")
        self.assertEqual(self.executor.call_count, 2)

    def test_sqlite_failure_keeps_projection_and_pending_receipt_after_restart(self):
        db = self.project._journal.db
        with db:
            db.execute("""
                CREATE TEMP TRIGGER reject_reconciliation
                BEFORE UPDATE ON action_receipts
                BEGIN
                    SELECT RAISE(ABORT, 'fixture write failure');
                END
            """)
        with self.client() as client:
            self.assertEqual(self.post(client, self.receipt()).status_code, 503)
        self.assert_blocked()
        self.reopen()
        self.assert_blocked()
        self.assertEqual(self.project.reconcile_action(self.receipt())["status"], "completed")
        self.assert_state("reviewed")
        self.reopen()
        self.assert_state("reviewed")
        self.executor.assert_called_once()

    def test_changed_model_bundle_keeps_original_request_pending(self):
        revised = self.journal.parent / "revised-model"
        shutil.copytree(MODELS / "document-review", revised)
        bindings_path = revised / "actions.json"
        bindings = json.loads(bindings_path.read_text(encoding="utf-8"))
        bindings["modelVersion"] = "1.1.0"
        bindings_path.write_text(json.dumps(bindings), encoding="utf-8")
        self.project.close()
        self.project = OntologyProject(revised, self.executor, receipt_db=self.journal)
        with self.client() as client:
            response = self.post(client, self.receipt())
            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["reason"], "model_bundle_changed")
        self.assert_blocked()
        self.reopen()
        self.assertEqual(self.project.reconcile_action(self.receipt())["status"], "completed")
        self.assert_state("reviewed")
        self.executor.assert_called_once()


if __name__ == "__main__":
    unittest.main()
