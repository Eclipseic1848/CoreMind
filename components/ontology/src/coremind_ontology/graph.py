"""加载宿主提供的 Turtle，并提供 RDF 查询与 SHACL Core 校验。"""

from hashlib import sha256
from heapq import nsmallest

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.graph import ReadOnlyGraphAggregate
from rdflib.namespace import RDF, SH


MAX_TURTLE_BYTES = 1024 * 1024
MAX_TRIPLES = 10_000
MAX_VIOLATIONS = 100
UNSUPPORTED_SH_TERMS = {
    "ask", "construct", "expression", "function", "nodeValidator", "propertyValidator",
    "rule", "select", "target", "validator", "ConstraintComponent", "Rule", "TripleRule",
}
REPORT_FIELDS = {
    "focusNode": SH.focusNode,
    "path": SH.resultPath,
    "sourceShape": SH.sourceShape,
    "constraintComponent": SH.sourceConstraintComponent,
    "severity": SH.resultSeverity,
}


def _node_text(node):
    if isinstance(node, BNode):
        return node.n3()
    return None if node is None else str(node)


def _uses_executable_shacl(shapes: Graph) -> bool:
    terms = set(shapes.predicates()) | set(shapes.objects(None, RDF.type))
    for term in terms:
        if str(term).startswith(str(SH)):
            name = str(term).removeprefix(str(SH))
            if name in UNSUPPORTED_SH_TERMS or name.startswith(("sparql", "SPARQL", "js", "JS")):
                return True
    return False


def _violations(report: Graph, results):
    for result in results:
        row = {key: _node_text(report.value(result, predicate)) for key, predicate in REPORT_FIELDS.items()}
        row["message"] = "\n".join(sorted(str(message) for message in report.objects(result, SH.resultMessage)))
        yield row


def _validate_record_shapes(data: Graph, shapes: Graph, subject: URIRef):
    from pyshacl import Validator
    from pyshacl.entrypoints import meta_validate
    from pyshacl.graph_abstraction import DataGraph

    if len(shapes) and not meta_validate(shapes, inference="none")[0]:
        raise ValueError("SHACL 形状无效")
    target = DataGraph.from_rdflib(data)
    validator = Validator(target, shacl_graph=shapes, options={"max_validation_depth": 15})
    executor = validator.make_executor()
    reports = []
    conforms = True
    # 只限定根形状的目标。嵌套约束仍须校验关联对象，不能把全局 focus_nodes 传给它们。
    for shape in validator.shacl_graph.shapes:
        if subject in shape.focus_nodes(target):
            valid, findings = shape.validate(executor, target, focus=subject)
            conforms = conforms and valid
            reports.extend(findings)
    report, _ = validator.create_validation_report(validator.shacl_graph, conforms, reports)
    return conforms, report


class OntologyGraph:
    def __init__(self, model_turtle: str, shapes_turtle: str, data_turtle: str = ""):
        sources = (model_turtle, shapes_turtle, data_turtle)
        encoded = [source.encode("utf-8") for source in sources]
        if sum(map(len, encoded)) > MAX_TURTLE_BYTES:
            raise ValueError("本体 Turtle 输入超过大小上限")
        digest = sha256()
        for source in encoded[:2]:
            digest.update(len(source).to_bytes(8, "big"))
            digest.update(source)
        self.model_digest = digest.hexdigest()

        # 固定解析基址，确保相同内容换目录后仍解析为相同 IRI。
        self._model, self._shapes, self._data = (
            Graph().parse(data=source.removeprefix("\ufeff"), format="turtle", publicID="https://coremind.invalid/ontology/")
            for source in sources
        )
        if len(self._model) + len(self._shapes) + len(self._data) > MAX_TRIPLES:
            raise ValueError("本体三元组数量超过上限")

    @property
    def model(self) -> ReadOnlyGraphAggregate:
        return ReadOnlyGraphAggregate([self._model])

    @property
    def data(self) -> ReadOnlyGraphAggregate:
        return ReadOnlyGraphAggregate([self._data])

    def set_state(self, resource: str, predicate: str, value: str) -> None:
        """由宿主在已有动作回执确认成功后更新实例状态。"""
        self._data.set((URIRef(resource), URIRef(predicate), Literal(value)))

    def describe(self, resource: str) -> dict:
        node = URIRef(resource)
        graphs = (self._model, self._data)
        pairs = {pair for graph in graphs for pair in graph.predicate_objects(node)}
        types, properties, relationships = [], [], []
        for predicate, value in sorted(pairs, key=lambda pair: (str(pair[0]), pair[1].n3())):
            if predicate == RDF.type:
                types.append(_node_text(value))
            elif isinstance(value, Literal):
                properties.append({
                    "predicate": str(predicate),
                    "value": str(value),
                    "datatype": _node_text(value.datatype),
                    "language": value.language,
                })
            else:
                relationships.append({"predicate": str(predicate), "target": _node_text(value)})
        return {
            "modelDigest": self.model_digest,
            "resource": resource,
            "found": bool(pairs) or any((None, None, node) in graph for graph in graphs),
            "types": types,
            "properties": properties,
            "relationships": relationships,
        }

    def validate(self, extra: Graph | None = None, *, subject: URIRef | None = None) -> dict:
        return self._validate(self._data, extra, subject=subject)

    def validate_state(self, resource: str, predicate: str, value: str) -> dict:
        """校验宿主待提交的状态，保留当前实例数据。"""
        return self.prepare_state(resource, predicate, value)[1]

    def prepare_state(self, resource: str, predicate: str, value: str) -> tuple[Graph, dict]:
        data = Graph()
        data += self._data
        data.set((URIRef(resource), URIRef(predicate), Literal(value)))
        return data, self._validate(data)

    def publish_state(self, data: Graph) -> None:
        self._data = data

    def _validate(self, instances: Graph, extra: Graph | None = None, *, subject: URIRef | None = None) -> dict:
        result = {"status": "unavailable", "modelDigest": self.model_digest, "violations": []}
        if _uses_executable_shacl(self._shapes):
            return dict(result, reason="unsupported-shape-feature")
        triple_count = len(self._model) + len(self._shapes) + len(instances)
        if triple_count + (len(extra) if extra is not None else 0) > MAX_TRIPLES:
            return dict(result, reason="input-limit")
        try:
            from pyshacl import validate as validate_shacl
        except ImportError:
            return dict(result, reason="engine-unavailable")
        try:
            data = Graph()
            data += instances
            if subject is not None:
                # 仅替换实例快照，保留模型中同名 IRI 的类层级和属性声明。
                data.remove((subject, None, None))
            data += self._model
            if extra is not None:
                data += extra
            if subject is not None:
                conforms, report = _validate_record_shapes(data, self._shapes, subject)
            else:
                conforms, report, _ = validate_shacl(
                    data, shacl_graph=self._shapes, inference="none", advanced=False, js=False,
                    do_owl_imports=False, max_validation_depth=15, meta_shacl=bool(self._shapes),
                )
            if not isinstance(report, Graph):
                return dict(result, reason="validation-error")
            results = list(report.objects(None, SH.result))
            violations = nsmallest(
                MAX_VIOLATIONS,
                _violations(report, results),
                key=lambda row: tuple(value or "" for value in row.values()),
            )
        except Exception:
            return dict(result, reason="validation-error")
        return dict(
            result,
            status="conforms" if conforms else "violates",
            violations=violations,
            resultCount=len(results),
            truncated=len(results) > MAX_VIOLATIONS,
        )
