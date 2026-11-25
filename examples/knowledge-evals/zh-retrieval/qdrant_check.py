"""核对真实模型的空稀疏查询、失败替换、版本切换时刻与权限边界。"""

import argparse
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from qdrant_retrieval import KnowledgeIndex


def check(model_dir):
    old = {
        "docId": "手册",
        "version": 1,
        "file": "手册.md",
        "line": 2,
        "text": "旧版说明",
        "validFrom": "2025-01-01",
        "validUntil": "2026-01-01",
        "access": "public",
    }
    new = dict(
        old, version=2, line=3, text="新版说明", validFrom="2026-01-01", validUntil=None
    )
    private = dict(
        old,
        docId="内部",
        file="内部.md",
        text="值班说明",
        access="desk",
        validUntil=None,
    )
    with closing(KnowledgeIndex(model_dir)) as index:
        index.replace([old, new, private])
        context = {"scope": "public", "as_of": "2026-01-01"}
        for mode in ("dense", "sparse", "hybrid"):
            assert index.search("说明", **context, mode=mode) == [new]
        dense, sparse = next(index._encode(["<unk>"]))
        assert sparse.indices == []
        for mode in ("sparse", "hybrid"):
            assert index.search("<unk>", **context, mode=mode) == []
        with patch.object(
            index, "_encode", return_value=iter([([0.0] * len(dense), sparse)])
        ):
            assert index.search("说明", **context, mode="dense") == []
        for invalid in ([dict(new, line=0)], [new] * 8 + [dict(private, text="说明 " * 513)]):
            try:
                index.replace(invalid)
            except ValueError:
                pass
            else:
                raise AssertionError("无效替换必须报错")
            assert index.search("说明", **context) == [new]
        index.replace([private])
        assert index.search("说明", **context) == []
        assert index.search("说明", scope="desk", as_of=context["as_of"]) == [private]
        index.replace([])
        assert index.search("说明", scope="desk", as_of=context["as_of"]) == []


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    check(parser.parse_args().model_dir)
    print("空向量、失败替换、版本边界与权限检查通过。")
