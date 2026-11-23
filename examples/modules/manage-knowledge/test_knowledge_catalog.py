"""知识增量与撤回的验收测试。"""

import json
import tempfile
import unittest
from pathlib import Path

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

    def replace(self, chunks):
        if self.fail:
            raise RuntimeError("重建失败")
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
            catalog.resolve("资料室手册", 1, "手册-v1.md", 1)["status"], "withdrawn"
        )
        self.assertEqual(
            catalog.resolve("资料室手册", 2, "手册-v2.md", 5)["status"], "available"
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
                second.resolve("资料室手册", 1, "手册-v1.md", 1)["status"],
                "withdrawn",
            )
            self.assertEqual(
                second.search("原件", scope="public", as_of="2026-10-01"), []
            )
            self.assertEqual(second.import_document(document()), "unchanged")


if __name__ == "__main__":
    unittest.main()
