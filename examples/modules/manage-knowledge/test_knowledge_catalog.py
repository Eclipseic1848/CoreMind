"""知识增量与撤回的验收测试。"""

import asyncio
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from unittest.mock import patch

from knowledge_catalog import KnowledgeCatalog, KnowledgeVersionConflict


def document(version=1, text="原件正文", file="手册-v1.md", line=1, until=None):
    return {
        "docId": "资料室手册",
        "version": version,
        "file": file,
        "access": "public",
        "validFrom": "2026-01-01",
        "validUntil": until,
        "chunks": [{"text": text, "line": line}],
    }


class FakeIndex:
    """只验证目录行为，不加载真实嵌入模型。"""

    def __init__(self):
        self.chunks = []
        self.generation = 0
        self.fail = False

    def replace(self, chunks, *, before_publish=None):
        if self.fail:
            raise RuntimeError("重建失败")
        if before_publish is not None:
            before_publish()
        self.chunks = [dict(chunk) for chunk in chunks]
        self.generation += 1

    def clear(self):
        if self.fail:
            raise RuntimeError("重建失败")
        self.chunks = []
        self.generation += 1

    def search(self, query, **_kwargs):
        return [chunk for chunk in self.chunks if query in chunk["text"]]


class KnowledgeCatalogTest(unittest.TestCase):
    reader = {"scope": "public", "as_of": "2026-10-01"}

    def test_mcp_health_responds_while_search_is_running(self):
        from starlette.testclient import TestClient
        from knowledge_server import make_app

        token = "Bearer knowledge-fixture"
        headers = {"Authorization": token, "Accept": "application/json, text/event-stream"}
        catalog = KnowledgeCatalog(FakeIndex())
        arrived, release = Event(), Event()

        def search(*_args, **_kwargs):
            arrived.set()
            self.assertTrue(release.wait(10))
            return []

        with patch.object(catalog, "search", side_effect=search), TestClient(
            make_app(catalog, "public", self.reader["as_of"], token.encode("utf-8")),
            base_url="http://127.0.0.1:8767",
        ) as client, ThreadPoolExecutor(max_workers=2) as pool:
            reply = pool.submit(client.post, "/mcp", headers=headers, json={
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "search_knowledge", "arguments": {"query": "查询"}},
            })
            try:
                self.assertTrue(arrived.wait(5))
                self.assertEqual(pool.submit(client.get, "/health", headers=headers).result(timeout=3).status_code, 200)
                self.assertFalse(reply.done())
            finally:
                release.set()
            self.assertEqual(json.loads(reply.result(timeout=5).json()["result"]["content"][0]["text"]), {"citations": []})

    def test_document_ids_round_trip_without_merging_legacy_values(self):
        from mcp.server.fastmcp import FastMCP
        from knowledge_server import make_app

        canonical = {**document(text="正常原文"), "docId": "记录"}
        padded = {**document(text="旧目录原文甲"), "docId": " 记录 ", "access": "records"}
        long = {**document(text="旧目录原文乙"), "docId": "甲" * 201, "access": "records"}
        maximum = {**document(text="上限原文"), "docId": "乙" * 200}

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({"schemaVersion": 1, "documents": [padded, long]}), encoding="utf-8")
            catalog = KnowledgeCatalog(FakeIndex(), path)
            self.assertEqual(catalog.import_documents([padded, long]), {"imported": 0, "unchanged": 2})
            for invalid in [padded, long]:
                with self.assertRaisesRegex(ValueError, "新文档 ID"):
                    catalog.import_document({**invalid, "version": 2})
            catalog.import_documents([canonical, maximum])
            catalog = KnowledgeCatalog(FakeIndex(), path)
            server = FastMCP("test")
            with patch("coremind_knowledge_mcp.server.FastMCP", return_value=server):
                make_app(catalog, "records", self.reader["as_of"], b"fixture")

            def call(tool, **args):
                result = asyncio.run(server.call_tool(tool, args))
                return json.loads(result[0].text)

            for record in [padded, long, canonical, maximum]:
                with self.subTest(doc_id=record["docId"]):
                    (hit,) = call("search_knowledge", query=record["chunks"][0]["text"])["citations"]
                    self.assertEqual(hit["docId"], record["docId"])
                    result = call("resolve_citation", **{key: hit[key] for key in ("docId", "version", "file", "line")})
                    self.assertEqual(result["text"], hit["text"])
                    self.assertEqual(result["status"], "available")
            for doc_id in [padded["docId"], long["docId"]]:
                self.assertEqual(catalog.resolve(doc_id, 1, padded["file"], 1, **self.reader)["status"], "unknown")
                catalog.withdraw(doc_id, 1)
                self.assertEqual(call("resolve_citation", docId=doc_id, version=1, file=padded["file"], line=1)["status"], "withdrawn")

    def test_same_version_and_content_is_unchanged(self):
        index = FakeIndex()
        catalog = KnowledgeCatalog(index)
        self.assertEqual(catalog.import_document(document()), "imported")
        generation = index.generation
        self.assertEqual(catalog.import_document(document()), "unchanged")
        self.assertEqual(index.generation, generation)
        self.assertEqual(len(index.chunks), 1)

    def test_same_version_with_changed_content_is_rejected(self):
        catalog = KnowledgeCatalog(FakeIndex())
        catalog.import_document(document())
        with self.assertRaises(KnowledgeVersionConflict):
            catalog.import_document(document(text="另一份正文"))

    def test_withdraw_removes_search_and_marks_citation(self):
        index = FakeIndex()
        catalog = KnowledgeCatalog(index)
        catalog.import_document(document(version=1, text="旧版窗口"))
        catalog.import_document(
            document(version=2, text="新版窗口", file="手册-v2.md", line=5)
        )
        self.assertTrue(catalog.search("旧版", scope="public", as_of="2026-10-01"))
        self.assertEqual(catalog.withdraw("资料室手册", 1), "withdrawn")
        self.assertEqual(catalog.search("旧版", scope="public", as_of="2026-10-01"), [])
        self.assertEqual(
            catalog.resolve("资料室手册", 1, "手册-v1.md", 1, **self.reader)["status"], "withdrawn"
        )
        self.assertEqual(
            catalog.resolve("资料室手册", 2, "手册-v2.md", 5, **self.reader)["status"], "available"
        )

    def test_citation_visibility_uses_reader_scope_and_half_open_dates(self):
        catalog = KnowledgeCatalog(FakeIndex())
        catalog.import_document({**document(until="2026-10-01"), "access": "editor"})
        def resolve(scope, day):
            return catalog.resolve("资料室手册", 1, "手册-v1.md", 1, scope=scope, as_of=day)
        unknown = {"status": "unknown", "docId": "资料室手册", "version": 1}
        self.assertEqual(resolve("editor", "2026-01-01")["text"], "原件正文")
        self.assertEqual(resolve("editor", "2025-12-31"), unknown)
        self.assertEqual(resolve("editor", "2026-10-01"), unknown)
        self.assertEqual(resolve("public", "2026-01-01"), unknown)
        catalog.withdraw("资料室手册", 1)
        self.assertEqual(resolve("editor", "2026-01-01")["status"], "withdrawn")
        self.assertEqual(resolve("public", "2026-01-01"), unknown)

    def test_failed_state_replace_preserves_visible_version_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            catalog = KnowledgeCatalog(FakeIndex(), state)
            catalog.import_document(document())
            with patch("coremind_knowledge_mcp.catalog.os.replace", side_effect=OSError("落盘失败")):
                with self.assertRaises(OSError):
                    catalog.withdraw("资料室手册", 1)
                with self.assertRaises(OSError):
                    catalog.import_document(document(version=2, text="二版正文"))
            for instance in (catalog, KnowledgeCatalog(FakeIndex(), state)):
                self.assertTrue(instance.search("原件正文", **self.reader))
                self.assertEqual(instance.search("二版正文", **self.reader), [])
                self.assertEqual(
                    instance.resolve("资料室手册", 1, "手册-v1.md", 1, **self.reader)["status"],
                    "available",
                )

    def test_failed_rebuild_keeps_previous_index_and_state(self):
        index = FakeIndex()
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            catalog = KnowledgeCatalog(index, state)
            catalog.import_document(document())
            before = state.read_bytes()
            index.fail = True
            with self.assertRaises(RuntimeError):
                catalog.withdraw("资料室手册", 1)
            index.fail = False
            self.assertEqual(state.read_bytes(), before)
            self.assertTrue(catalog.search("原件", scope="public", as_of="2026-10-01"))

    def test_state_survives_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            first = KnowledgeCatalog(FakeIndex(), state)
            first.import_document(document())
            first.withdraw("资料室手册", 1)

            index = FakeIndex()
            second = KnowledgeCatalog(index, state)
            self.assertEqual(
                second.resolve("资料室手册", 1, "手册-v1.md", 1, **self.reader)["status"],
                "withdrawn",
            )
            self.assertEqual(
                second.search("原件", scope="public", as_of="2026-10-01"), []
            )
            self.assertEqual(second.import_document(document()), "unchanged")

    def test_page_and_section_citations_round_trip_from_a_legacy_catalog(self):
        from mcp.server.fastmcp import FastMCP
        from knowledge_server import make_app

        for file, locator in [("值班记录.pdf", "page:1"), ("归档窗口.docx", "section:归档窗口")]:
            with self.subTest(file=file), tempfile.TemporaryDirectory() as directory:
                state = Path(directory) / "state.json"
                record = {
                    **document(file=file, until="2027-01-01"),
                    "access": "editor",
                    "chunks": [
                        {"text": "位置相同的标题", "locator": locator},
                        {"text": "位置相同的正文", "locator": locator},
                        {"text": "位置唯一的正文", "locator": "旧版独有位置"},
                    ],
                }
                state.write_text(json.dumps({"schemaVersion": 1, "documents": [record]}), encoding="utf-8")
                original = state.read_bytes()
                identity = {"docId": record["docId"], "version": 1, "file": file}
                for _ in range(2):
                    catalog = KnowledgeCatalog(FakeIndex(), state)
                    self.assertEqual(catalog.import_document(record), "unchanged")
                    server = FastMCP("test")
                    with patch("coremind_knowledge_mcp.server.FastMCP", return_value=server):
                        make_app(catalog, "editor", "2026-10-01", b"fixture")

                    def call(tool, **args):
                        result = asyncio.run(server.call_tool(tool, args))
                        return json.loads(result[0].text)

                    hits = call("search_knowledge", query="位置相同")["citations"]
                    self.assertEqual([hit["chunkId"] for hit in hits], [1, 2])
                    for hit in hits:
                        resolved = call("resolve_citation", **identity, chunkId=hit["chunkId"])
                        self.assertEqual(resolved["status"], "available")
                        for field in ("text", "locator", "chunkId"):
                            self.assertEqual(resolved[field], hit[field])
                    self.assertEqual(call("resolve_citation", **identity, locator=locator)["status"], "ambiguous")
                    self.assertNotIn("text", call("resolve_citation", **identity, locator=locator))
                    self.assertEqual(call("resolve_citation", **identity, locator="旧版独有位置")["text"], "位置唯一的正文")
                    self.assertEqual(call("resolve_citation", **identity, locator=locator, chunkId=3)["status"], "missing")
                    self.assertEqual(call("resolve_citation", **identity, chunkId=4)["status"], "missing")

                self.assertEqual(state.read_bytes(), original)
                for scope, day in [("public", "2026-10-01"), ("editor", "2027-01-01")]:
                    resolved = catalog.resolve(record["docId"], 1, file, chunk_id=2, scope=scope, as_of=day)
                    self.assertEqual(resolved, {"status": "unknown", "docId": record["docId"], "version": 1})
                catalog.withdraw(record["docId"], 1)
                restarted = KnowledgeCatalog(FakeIndex(), state)
                self.assertEqual(restarted.search("位置相同", scope="editor", as_of="2026-10-01"), [])
                resolved = restarted.resolve(record["docId"], 1, file, chunk_id=2, scope="editor", as_of="2026-10-01")
                self.assertEqual(resolved, {"status": "withdrawn", "docId": record["docId"], "version": 1})

    def test_markdown_table_context_survives_legacy_reimport_and_matches_both_tools(self):
        from mcp.server.fastmcp import FastMCP
        from knowledge_server import load_corpus, make_app

        source = (
            "| 资料 | 本周新增规定 |\n| --- | --- |\n| 新制度草稿 | 档案交接登记 |\n\n"
            "普通正文 | 含竖线\n\n"
            "~~~markdown\n| 伪表头 | 含义 |\n| --- | --- |\n| 伪数据 | 误读 |\n~~~\n\n"
            "名称 | 值班窗口\n--- | ---\n编号 | 榆木台\n"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sources").mkdir()
            file = root / "sources/草稿.md"
            file.write_text(source, encoding="utf-8")
            manifest = root / "manifest.json"
            entry = {
                "id": "draft", "version": 1, "file": file.name, "access": "editor",
                "validFrom": "2026-01-01", "validUntil": "2027-01-01",
            }
            manifest.write_text(json.dumps({"asOf": "2026-05-01", "documents": [entry]}), encoding="utf-8")
            day, (record,) = load_corpus(manifest)
            state = root / "state.json"
            legacy = {k: v for k, v in record.items() if k != "tableHeaders"}
            catalog = KnowledgeCatalog(FakeIndex(), state)
            catalog.import_document(legacy)
            catalog.import_document({**legacy, "version": 2})
            catalog.withdraw("draft", 2)
            catalog = KnowledgeCatalog(FakeIndex(), state)
            self.assertEqual(
                catalog.import_documents([record, {**record, "version": 2}]),
                {"imported": 0, "unchanged": 2},
            )
            generation = catalog.index.generation
            self.assertEqual(catalog.import_document(record), "unchanged")
            self.assertEqual(catalog.index.generation, generation)
            catalog = KnowledgeCatalog(FakeIndex(), state)
            server = FastMCP("test")
            with patch("coremind_knowledge_mcp.server.FastMCP", return_value=server):
                make_app(catalog, "editor", day, b"fixture")

            def call(tool, **args):
                content = asyncio.run(server.call_tool(tool, args))
                return json.loads(content[0].text)

            for line, header in [(3, 1), (15, 13)]:
                text = source.splitlines()[line - 1]
                expected = [{"line": header, "text": source.splitlines()[header - 1]}]
                (hit,) = call("search_knowledge", query=text)["citations"]
                self.assertEqual((hit["line"], hit["text"], hit.get("tableHeader")), (line, text, expected))
                resolved = call("resolve_citation", docId="draft", version=1, file=file.name, line=line)
                self.assertEqual(resolved["tableHeader"], expected)
                self.assertEqual(resolved["text"], text)
            for line in (1, 5, 8, 10, 13):
                resolved = call("resolve_citation", docId="draft", version=1, file=file.name, line=line)
                self.assertNotIn("tableHeader", resolved)
            for version, scope, as_of, status in [
                (1, "public", day, "unknown"), (1, "editor", "2027-01-01", "unknown"),
                (2, "editor", day, "withdrawn"),
            ]:
                self.assertEqual(catalog.resolve("draft", version, file.name, 3, scope=scope, as_of=as_of),
                                 {"status": status, "docId": "draft", "version": version})
            file.write_text(source.replace("本周新增规定", "标题"), encoding="utf-8")
            _, (changed,) = load_corpus(manifest)
            with self.assertRaises(KnowledgeVersionConflict):
                catalog.import_document(changed)
            catalog.import_document({**changed, "version": 3})
            for version, column in [(1, "本周新增规定"), (3, "标题")]:
                resolved = call("resolve_citation", docId="draft", version=version, file=file.name, line=3)
                self.assertEqual(resolved["tableHeader"], [{"line": 1, "text": f"| 资料 | {column} |"}])


if __name__ == "__main__":
    unittest.main()
