import json
import shutil
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

from ontology_project import OntologyProject, demo_transition


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


if __name__ == "__main__":
    unittest.main()
