"""用真实本地 Qdrant 和确定性向量验证持久索引的发布边界。"""

import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing, redirect_stderr
from pathlib import Path
from unittest.mock import patch

from knowledge_catalog import KnowledgeCatalog
from coremind_knowledge_mcp import retrieval
from coremind_knowledge_mcp.server import main


class TestIndex(retrieval.KnowledgeIndex):
    def __init__(self, path):
        with (
            patch.object(retrieval, "verify_model"),
            patch.object(retrieval, "Tokenizer"),
            patch.object(retrieval.ort, "InferenceSession"),
        ):
            super().__init__(path.parent, index_dir=path)
        self.encoded = []

    def _encode(self, texts):
        self.encoded.extend(texts)
        for value in texts:
            terms = sorted({ord(char) for char in value})
            yield [1.0] + [0.0] * 1023, retrieval.models.SparseVector(
                indices=terms, values=[1.0] * len(terms)
            )


def document(ident, text, version=1, access="public", until=None):
    return {
        "docId": ident, "version": version, "file": f"{ident}.pdf", "access": access,
        "validFrom": "2026-01-01", "validUntil": until,
        "chunks": [{"locator": "page:1", "text": text}, {"locator": "page:1", "text": "固定页脚"}],
    }


def search(catalog, text, scope="public", day="2026-02-01"):
    return catalog.search(text, scope=scope, as_of=day)


class PersistentIndexTest(unittest.TestCase):
    def test_cli_index_directory_must_be_separate_from_catalog_assets(self):
        with tempfile.TemporaryDirectory() as folder:
            project = Path(folder)
            manifest, model, state = project / "manifest.json", project / "model", project / "catalog.json"
            for path in (project, project / "sources" / "index", model, state, state.with_suffix(".json.tmp")):
                with self.subTest(index_dir=path):
                    argv = ["coremind-knowledge-mcp", "--manifest", str(manifest), "--model-dir", str(model),
                            "--state", str(state), "--scope", "public", "--index-dir", str(path)]
                    env = {"COREMIND_KNOWLEDGE_AUTHORIZATION": "Bearer " + "x" * 24}
                    output = io.StringIO()
                    with patch.object(sys, "argv", argv), patch.dict("os.environ", env), redirect_stderr(output):
                        with self.assertRaises(SystemExit) as error:
                            main()
                    self.assertEqual(error.exception.code, 2)
                    self.assertIn("--index-dir 必须与状态文件", output.getvalue())

    def test_cold_open_update_and_withdraw(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path = root / "vectors"
            state = root / "catalog.json"
            original = document("manual", "蓝鹭")
            restricted = document("private", "紫藤", access="records", until="2026-03-01")
            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                catalog.import_documents([original, restricted])
                self.assertEqual(index.encoded, ["蓝鹭", "固定页脚", "紫藤", "固定页脚"])
                lock = subprocess.run(
                    [sys.executable, "-B", "-X", "utf8", "-c",
                     "import sys; from qdrant_client import QdrantClient; QdrantClient(path=sys.argv[1]).close()",
                     str(path)],
                    capture_output=True, timeout=20, encoding="utf-8",
                )
                self.assertNotEqual(lock.returncode, 0)
                self.assertIn("already accessed", lock.stderr)

            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                self.assertEqual(index.encoded, [])
                self.assertEqual(search(catalog, "紫藤"), [])
                self.assertEqual(search(catalog, "紫藤", "records", "2026-03-01"), [])
                (hit,) = search(catalog, "紫藤", "records")
                self.assertEqual(hit["chunkId"], 1)
                self.assertNotIn("_generation", hit)
                resolved = catalog.resolve("private", 1, "private.pdf", chunk_id=hit["chunkId"],
                                           scope="records", as_of="2026-02-01")
                self.assertEqual(resolved["text"], hit["text"])

                index.encoded.clear()
                catalog.import_documents([document("manual", "翠谷", version=2)],
                                         withdrawals=[("manual", 1)])
                self.assertEqual(index.encoded, ["翠谷"])
                self.assertEqual(search(catalog, "蓝鹭"), [])
                self.assertEqual(search(catalog, "翠谷")[0]["version"], 2)
                index.encoded.clear()
                catalog.withdraw("manual", 2)
                self.assertEqual(index.encoded, [])

            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                self.assertEqual(index.encoded, [])
                self.assertEqual(search(catalog, "翠谷"), [])
                resolved = catalog.resolve("manual", 2, "manual.pdf", chunk_id=1,
                                           scope="public", as_of="2026-02-01")
                self.assertEqual(resolved["status"], "withdrawn")

    def test_partial_upsert_and_failed_catalog_save_survive_reopen(self):
        for failure in ("partial-upsert", "catalog-save"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                path, state = root / "vectors", root / "catalog.json"
                original, replacement = document("manual", "蓝鹭"), document("manual", "翠谷", version=2)
                with closing(TestIndex(path)) as index:
                    catalog = KnowledgeCatalog(index, state)
                    catalog.import_document(original)
                    old = state.read_bytes()
                    write = index.db.upsert

                    def fail_after_one(collection_name, points, **kwargs):
                        write(collection_name, points[:1], **kwargs)
                        raise OSError("模拟索引写入中断")

                    fault = (
                        patch.object(index.db, "upsert", side_effect=fail_after_one)
                        if failure == "partial-upsert"
                        else patch.object(catalog, "_save", side_effect=OSError("模拟目录发布失败"))
                    )
                    with fault, self.assertRaises(OSError):
                        catalog.import_documents([replacement], withdrawals=[("manual", 1)])
                    self.assertEqual(state.read_bytes(), old)
                    self.assertEqual(search(catalog, "蓝鹭")[0]["version"], 1)
                    self.assertEqual(search(catalog, "翠谷"), [])

                with closing(TestIndex(path)) as index:
                    catalog = KnowledgeCatalog(index, state)
                    self.assertEqual(index.encoded, [])
                    self.assertEqual(search(catalog, "蓝鹭")[0]["version"], 1)
                    self.assertEqual(search(catalog, "翠谷"), [])
                    catalog.import_documents([replacement], withdrawals=[("manual", 1)])
                    self.assertEqual(search(catalog, "蓝鹭"), [])
                    self.assertEqual(search(catalog, "翠谷")[0]["version"], 2)

    def test_matching_point_count_does_not_accept_changed_reader_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path, state = root / "vectors", root / "catalog.json"
            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                catalog.import_document(document("private", "紫藤", access="records"))
                points, _ = index.db.scroll("knowledge")
                index.db.set_payload("knowledge", {"access": "public"},
                                     points=[point.id for point in points])

            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                self.assertEqual(set(index.encoded), {"紫藤", "固定页脚"})
                self.assertEqual(search(catalog, "紫藤"), [])
                self.assertEqual(search(catalog, "紫藤", "records")[0]["access"], "records")

    def test_last_point_persistence_error_rewrites_in_process_before_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            path, state = root / "vectors", root / "catalog.json"
            original, replacement = document("manual", "蓝鹭"), document("manual", "翠谷", version=2)
            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                catalog.import_document(original)
                old = state.read_bytes()
                storage = index.db._client.collections["knowledge"].storage
                persist = storage.persist
                writes = 0

                def fail_last_point(point):
                    nonlocal writes
                    writes += 1
                    if writes == len(replacement["chunks"]):
                        raise OSError("模拟最后一点 SQLite 写入失败")
                    persist(point)

                with patch.object(storage, "persist", side_effect=fail_last_point), self.assertRaises(OSError):
                    catalog.import_documents([replacement], withdrawals=[("manual", 1)])
                self.assertEqual(writes, 2)
                self.assertEqual(state.read_bytes(), old)
                self.assertEqual(search(catalog, "蓝鹭")[0]["version"], 1)
                self.assertEqual(search(catalog, "翠谷"), [])

                with patch.object(storage, "persist", wraps=persist) as rewrite:
                    catalog.import_documents([replacement], withdrawals=[("manual", 1)])
                self.assertEqual(rewrite.call_count, 2)
                self.assertEqual(search(catalog, "蓝鹭"), [])
                self.assertEqual(search(catalog, "翠谷")[0]["version"], 2)

            with closing(TestIndex(path)) as index:
                catalog = KnowledgeCatalog(index, state)
                self.assertEqual(index.encoded, [])
                self.assertEqual(search(catalog, "翠谷")[0]["version"], 2)


if __name__ == "__main__":
    unittest.main()
