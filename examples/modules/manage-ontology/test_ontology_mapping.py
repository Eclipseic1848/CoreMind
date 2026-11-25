"""验证两套来源的归一规则、换算证据与人工确认边界。"""

import unittest
from decimal import Decimal

from rdflib import RDF, XSD, Literal, Namespace, URIRef

from ontology_mapping import map_record


EX = Namespace("urn:sample:")


class MappingTests(unittest.TestCase):
    def setUp(self):
        fields = [
            {"aliases": ["status", "状态"], "predicate": str(EX.state),
             "codes": {"R": "ready", "已就绪": "ready", "D": "draft"}},
            {"aliases": ["克重"], "predicate": str(EX.kg), "scale": "0.001",
             "datatype": str(XSD.decimal)},
            {"aliases": ["替代对象"], "predicate": str(EX.replaces), "term": "iri"},
        ]
        self.mapping = {"version": "v3", "sources": {
            "甲": {"idField": "编号", "class": str(EX.Material), "fields": fields,
                  "identities": {"1": {"confirmed": str(EX.one)},
                                 "2": {"candidates": [str(EX.one), str(EX.two)]},
                                 "3": {"confirmed": str(EX.one), "candidates": [str(EX.two)]}}},
            "乙": {"idField": "id", "class": str(EX.Material), "fields": fields,
                  "identities": {"B": {"confirmed": str(EX.one)}}},
        }}

    def test_confirmed_identity_normalization_preserves_evidence(self):
        raw = {"编号": "1", "status": "R", "状态": "已就绪", "克重": 2500, "替代对象": str(EX.old)}
        result, graph = map_record(self.mapping, "甲", raw)
        self.assertEqual(result["status"], "mapped")
        self.assertEqual((result["source"], result["sourceId"], result["mappingVersion"]), ("甲", "1", "v3"))
        self.assertEqual(result["original"], raw)
        self.assertEqual(result["fields"][0]["aliases"], ["status", "状态"])
        self.assertIn((EX.one, EX.state, Literal("ready")), graph)
        self.assertIn((EX.one, EX.replaces, EX.old), graph)
        self.assertEqual(graph.value(EX.one, EX.kg).toPython(), Decimal("2.5"))
        self.assertEqual(graph.value(EX.one, EX.kg).datatype, XSD.decimal)
        second, other = map_record(self.mapping, "乙", {"id": "B", "status": "R"})
        self.assertEqual(second["subject"], result["subject"])
        self.assertIn((EX.one, RDF.type, EX.Material), other)

    def test_unconfirmed_or_conflicting_record_produces_no_triples(self):
        for raw, candidates in [
            ({"编号": "2"}, [str(EX.one), str(EX.two)]), ({"编号": "3"}, [str(EX.two)]),
            ({"编号": "未知"}, []), ({}, []),
            ({"编号": "1", "status": "R", "状态": "D"}, []),
            ({"编号": "1", "status": "未知"}, []),
            ({"编号": "1", "status": "R", "克重": "非数值"}, []),
        ]:
            with self.subTest(raw=raw):
                result, graph = map_record(self.mapping, "甲", raw)
                self.assertEqual(result["status"], "needs_confirmation")
                self.assertEqual(result["candidates"], candidates)
                self.assertEqual(result["original"], raw)
                self.assertFalse(graph)
        unknown_source, graph = map_record(self.mapping, "丙", {"编号": "1"})
        self.assertEqual(unknown_source["status"], "needs_confirmation")
        self.assertFalse(graph)

    def test_business_can_replace_model_vocabulary(self):
        schema = self.mapping["sources"]["甲"]
        schema.update({"class": "urn:other:Container", "fields": [
            {"aliases": ["标签"], "predicate": "urn:other:label"}
        ]})
        _, graph = map_record(self.mapping, "甲", {"编号": "1", "标签": "白色"})
        self.assertIn((EX.one, RDF.type, URIRef("urn:other:Container")), graph)
        self.assertIn((EX.one, URIRef("urn:other:label"), Literal("白色")), graph)


if __name__ == "__main__":
    unittest.main()
