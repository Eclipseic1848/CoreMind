"""本体图适配器的本地回归。"""

import unittest
from unittest.mock import patch

from rdflib import Graph, Literal, URIRef
from rdflib.graph import ModificationException
from rdflib.namespace import SH

from ontology_graph import OntologyGraph


BASE = "urn:test:ontology:"
PREFIXES = f"""
@prefix ex: <{BASE}> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
"""
MODEL = PREFIXES + 'ex:Book a rdfs:Class . ex:PrintedBook rdfs:subClassOf ex:Book .'
SHAPES = PREFIXES + """
ex:BookShape a sh:NodeShape ; sh:targetClass ex:Book ; sh:property ex:TitleShape .
ex:TitleShape sh:path ex:title ; sh:minCount 1 ; sh:maxCount 1 ; sh:minLength 1 ; sh:message "图书需要标题" .
"""
DATA = PREFIXES + 'ex:item a ex:PrintedBook ; ex:title "地方志"@zh ; ex:heldBy ex:library .'


class OntologyGraphTest(unittest.TestCase):
    def test_describes_types_literals_and_outgoing_relationships(self):
        ontology = OntologyGraph(MODEL, SHAPES, DATA)
        row = ontology.describe(BASE + "item")
        self.assertTrue(row["found"])
        self.assertEqual(row["types"], [BASE + "PrintedBook"])
        self.assertEqual(row["properties"], [
            {"predicate": BASE + "title", "value": "地方志", "datatype": None, "language": "zh"},
        ])
        self.assertEqual(row["relationships"], [{"predicate": BASE + "heldBy", "target": BASE + "library"}])
        self.assertTrue(ontology.describe(BASE + "Book")["found"])
        self.assertTrue(ontology.describe(BASE + "library")["found"])
        self.assertEqual(ontology.describe(BASE + "library")["relationships"], [])
        self.assertFalse(ontology.describe(BASE + "missing")["found"])
        with self.assertRaises(ModificationException):
            ontology.data.remove((None, None, None))

    def test_digest_is_bound_to_exact_model_and_shapes(self):
        digest = OntologyGraph(MODEL, SHAPES, DATA).model_digest
        self.assertEqual(digest, OntologyGraph(MODEL, SHAPES).model_digest)
        self.assertNotEqual(digest, OntologyGraph(MODEL.replace("\n", "\r\n"), SHAPES).model_digest)
        self.assertNotEqual(digest, OntologyGraph(MODEL, SHAPES + "\n# 改版").model_digest)

    def test_validation_reports_core_violation_and_mapped_data_is_ephemeral(self):
        stored = PREFIXES + "ex:item a ex:PrintedBook ."
        ontology = OntologyGraph(MODEL, SHAPES, stored)
        violation = ontology.validate()
        self.assertEqual(violation["status"], "violates")
        self.assertEqual(violation["modelDigest"], ontology.model_digest)
        self.assertEqual(violation["violations"], [{
            "focusNode": BASE + "item",
            "path": BASE + "title",
            "sourceShape": BASE + "TitleShape",
            "constraintComponent": str(SH.MinCountConstraintComponent),
            "severity": str(SH.Violation),
            "message": "图书需要标题",
        }])
        addition = Graph().parse(data=PREFIXES + 'ex:item ex:title "地方志"@zh .', format="turtle")
        self.assertEqual(ontology.validate(extra=addition)["status"], "conforms")
        self.assertEqual(ontology.validate(), violation)

    def test_host_state_update_replaces_previous_value(self):
        ontology = OntologyGraph(MODEL, SHAPES, DATA)
        self.assertEqual(ontology.validate_state(BASE + "item", BASE + "title", "")["status"], "violates")
        self.assertEqual(ontology.validate_state(BASE + "item", BASE + "title", "地方文献")["status"], "conforms")
        query = (URIRef(BASE + "item"), URIRef(BASE + "title"))
        self.assertEqual(list(ontology.data.objects(*query)), [Literal("地方志", lang="zh")])
        ontology.set_state(BASE + "item", BASE + "title", "地方文献")
        self.assertEqual(list(ontology.data.objects(*query)), [Literal("地方文献")])
        self.assertEqual(ontology.validate()["status"], "conforms")

    def test_validation_engine_errors_are_unavailable(self):
        ontology = OntologyGraph(MODEL, SHAPES, DATA)
        with patch.dict("sys.modules", {"pyshacl": None}):
            self.assertEqual(ontology.validate()["reason"], "engine-unavailable")
        with patch("pyshacl.validate", side_effect=RuntimeError("内部故障")):
            self.assertEqual(ontology.validate(), {
                "status": "unavailable", "modelDigest": ontology.model_digest,
                "violations": [], "reason": "validation-error",
            })

    def test_dynamic_shape_features_are_rejected_before_engine_execution(self):
        for statement in (
            'ex:S sh:sparql ex:Constraint .',
            'ex:S sh:js ex:Constraint .',
            'ex:S sh:rule ex:Rule .',
            'ex:Custom a sh:ConstraintComponent ; sh:validator ex:Validator .',
            'ex:S sh:target ex:CustomTarget .',
        ):
            with self.subTest(statement=statement), patch("pyshacl.validate") as engine:
                ontology = OntologyGraph(MODEL, PREFIXES + statement, DATA)
                self.assertEqual(ontology.validate()["reason"], "unsupported-shape-feature")
                engine.assert_not_called()

    def test_large_violation_reports_preserve_total_and_failure_status(self):
        instances = PREFIXES + "\n".join(f"ex:item{index:03} a ex:Book ." for index in range(101))
        result = OntologyGraph(MODEL, SHAPES, instances).validate()
        self.assertEqual(result["status"], "violates")
        self.assertEqual(result["resultCount"], 101)
        self.assertEqual(len(result["violations"]), 100)
        self.assertTrue(result["truncated"])


if __name__ == "__main__":
    unittest.main()
