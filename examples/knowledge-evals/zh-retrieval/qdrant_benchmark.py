"""在固定 30/10 题上比较 BM25、BGE-M3 稠密、稀疏和融合检索。"""

import argparse
import json
import math
import sqlite3
from contextlib import ExitStack, closing
from importlib.metadata import version
from pathlib import Path
from statistics import median
from time import perf_counter

from keyword_baseline import ROOT, check_candidates, index, search, terms
from qdrant_retrieval import MODEL_FILES, MODEL_REPO, MODEL_REVISION, KnowledgeIndex


def read_corpus():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    documents = {doc["file"]: doc for doc in manifest["documents"]}
    chunks = {}
    for doc in documents.values():
        lines = (
            (ROOT / "sources" / doc["file"]).read_text(encoding="utf-8").splitlines()
        )
        for line, text in enumerate(lines, 1):
            # 沿用 P0 的物理行切块和空行规则，索引时不读题目与评分标注。
            if next(terms(text), None) is not None:
                chunks[doc["file"], line] = {
                    "docId": doc["id"],
                    "file": doc["file"],
                    "line": line,
                    "text": text,
                    "version": doc["version"],
                    "access": doc["access"],
                    "validFrom": doc["validFrom"],
                    "validUntil": doc["validUntil"],
                }

    return manifest, documents, chunks


def evaluate(model_dir):
    manifest, documents, chunks = read_corpus()
    with ExitStack() as resources:
        started = perf_counter()
        knowledge = KnowledgeIndex(model_dir)
        model_load = perf_counter() - started
        resources.callback(knowledge.close)
        started = perf_counter()
        knowledge.replace(chunks.values())
        vector_index = perf_counter() - started
        cases = [
            json.loads(row)
            for row in (ROOT / "cases.jsonl").read_text(encoding="utf-8").splitlines()
        ]
        lexical = {}
        started = perf_counter()
        for scope in {case["scope"] for case in cases}:
            db = resources.enter_context(closing(sqlite3.connect(":memory:")))
            index(db, manifest, scope)
            lexical[scope] = db
        lexical_index = perf_counter() - started
        methods = {}
        for mode in ("fts5-bm25", "dense", "sparse", "hybrid"):
            rows = []
            latency = []
            for case in cases:
                question, scope, day = case["question"], case["scope"], manifest["asOf"]
                started = perf_counter()
                if mode == "fts5-bm25":
                    candidates = [
                        chunks[key] for key in search(lexical[scope], question)
                    ]
                else:
                    candidates = knowledge.search(
                        question, scope=scope, as_of=day, mode=mode
                    )
                latency.append((perf_counter() - started) * 1000)
                keys = [(p["file"], p["line"]) for p in candidates]
                check_candidates(keys, scope, day, documents)
                for key, payload in zip(keys, candidates, strict=True):
                    if payload != chunks[key]:
                        raise ValueError(
                            f"{mode}/{case['id']} 的返回内容或来源元数据不符"
                        )
                gold = case["evidence"]
                rank = None
                if gold is not None:
                    expected = (gold["file"], gold["line"])
                    if gold["quote"] not in chunks[expected]["text"]:
                        raise ValueError(f"{case['id']} 的标准引文与源行不符")
                    if expected in keys:
                        rank = keys.index(expected) + 1
                rows.append(
                    {
                        "id": case["id"],
                        "answerable": gold is not None,
                        "rank": rank,
                        "candidates": [{"file": k[0], "line": k[1]} for k in keys],
                    }
                )
            answered = [r for r in rows if r["answerable"]]
            unknown = [r for r in rows if not r["answerable"]]
            methods[mode] = {
                "answerable": len(answered),
                "top1Hits": sum(r["rank"] == 1 for r in answered),
                "top5Hits": sum(r["rank"] is not None for r in answered),
                "mrrAt5": sum(1 / r["rank"] for r in answered if r["rank"])
                / len(answered),
                "missedTop1": [r["id"] for r in answered if r["rank"] != 1],
                "missedTop5": [r["id"] for r in answered if r["rank"] is None],
                "unanswerable": len(unknown),
                "unanswerableWithCandidates": sum(
                    bool(r["candidates"]) for r in unknown
                ),
                "candidatesChecked": sum(len(r["candidates"]) for r in rows),
                "medianQueryMs": median(latency),
                "p95QueryMs": sorted(latency)[math.ceil(len(latency) * 0.95) - 1],
                "cases": rows,
            }
    return {
        "model": MODEL_REPO,
        "revision": MODEL_REVISION,
        "sha256": MODEL_FILES,
        "versions": {
            p: version(p)
            for p in ("qdrant-client", "onnxruntime", "tokenizers", "numpy")
        },
        "asOf": manifest["asOf"],
        "chunks": len(chunks),
        "modelLoadSeconds": model_load,
        "vectorIndexSeconds": vector_index,
        "lexicalIndexSeconds": lexical_index,
        "methods": methods,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = evaluate(args.model_dir)
    if args.output:
        args.output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    for method, scores in report["methods"].items():
        print(
            method,
            json.dumps(
                {k: v for k, v in scores.items() if k != "cases"}, ensure_ascii=False
            ),
        )
