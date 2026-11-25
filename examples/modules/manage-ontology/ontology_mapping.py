"""按业务方已确认的映射，将一条来源记录转换为 RDF 并留下转换依据。"""

import re
from copy import deepcopy
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

from rdflib import RDF, Graph, Literal, URIRef


def _iri(value):
    if not isinstance(value, str) or not urlsplit(value).scheme or re.search(r'[\s<>"{}|^\\`]', value):
        raise ValueError(f"需要绝对 IRI：{value!r}")
    return URIRef(value)


def _field_value(rule, raw):
    if type(raw) not in (str, int, float, bool):
        raise ValueError("字段需要标量值")
    value = raw
    if "codes" in rule:
        if not isinstance(raw, str) or raw not in rule["codes"]:
            raise ValueError(f"编码未登记：{raw!r}")
        value = rule["codes"][raw]
    if "scale" in rule:
        number = Decimal(str(value)) * Decimal(str(rule["scale"]))
        if not number.is_finite():
            raise ValueError("单位换算需要有限数值")
        value = number
    if rule.get("term", "literal") == "iri":
        return _iri(value)
    if rule.get("term", "literal") != "literal":
        raise ValueError("未知的 RDF 项类型")
    term = Literal(value, datatype=_iri(rule["datatype"]) if "datatype" in rule else None)
    if term.ill_typed:
        raise ValueError(f"值不符合声明的数据类型：{value!r}")
    return term


def map_record(mapping: dict, source: str, record: dict) -> tuple[dict, Graph]:
    version = mapping.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("映射必须声明版本")
    schema = mapping["sources"].get(source)
    if schema is None:
        return {
            "status": "needs_confirmation", "source": source, "sourceId": None,
            "mappingVersion": version, "original": deepcopy(record), "subject": None,
            "candidates": [], "fields": [], "reason": "来源尚未登记",
        }, Graph()
    source_id = record.get(schema["idField"])
    identity = schema["identities"].get(source_id, {}) if isinstance(source_id, str) else {}
    summary = {
        "status": "needs_confirmation", "source": source, "sourceId": source_id,
        "mappingVersion": version, "original": deepcopy(record), "subject": None,
        "candidates": list(identity.get("candidates", [])), "fields": [],
    }
    confirmed = identity.get("confirmed")
    if not confirmed or summary["candidates"]:
        summary["reason"] = "来源标识尚未确认"
        return summary, Graph()
    subject = _iri(confirmed)
    graph = Graph()
    graph.add((subject, RDF.type, _iri(schema["class"])))
    for rule in schema["fields"]:
        aliases = [name for name in rule["aliases"] if record.get(name) is not None]
        if not aliases:
            continue
        predicate = _iri(rule["predicate"])
        try:
            values = {_field_value(rule, record[name]) for name in aliases}
        except (InvalidOperation, ValueError) as exc:
            summary.update(reason=str(exc), unresolvedFields=aliases)
            return summary, Graph()
        if len(values) != 1:
            summary.update(reason="别名字段的映射值冲突", unresolvedFields=aliases)
            return summary, Graph()
        value = values.pop()
        graph.add((subject, predicate, value))
        summary["fields"].append({"aliases": aliases, "predicate": str(predicate), "value": str(value)})
    summary.update(status="mapped", subject=str(subject))
    return summary, graph
