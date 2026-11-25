"""用 SQLite FTS5 对固定中文资料集测量关键词检索，不调用模型。"""

import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/knowledge/src"))

from coremind_knowledge_mcp.text import terms

ROOT = Path(__file__).resolve().parent


def index(db, manifest, scope):
    db.execute("CREATE VIRTUAL TABLE chunks USING fts5(words, file UNINDEXED, line UNINDEXED)")
    for doc in manifest["documents"]:
        if doc["access"] not in {"public", scope}:
            continue
        if doc["validFrom"] > manifest["asOf"] or (
            doc["validUntil"] is not None and manifest["asOf"] >= doc["validUntil"]
        ):
            continue
        lines = (ROOT / "sources" / doc["file"]).read_text(encoding="utf-8").splitlines()
        for line, content in enumerate(lines, 1):
            words = " ".join(terms(content))
            if words:
                db.execute("INSERT INTO chunks VALUES (?, ?, ?)", (words, doc["file"], line))


def search(db, question):
    query = " OR ".join(f'"{term}"' for term in dict.fromkeys(terms(question)))
    if not query:
        return []
    return db.execute(
        "SELECT file, line FROM chunks WHERE chunks MATCH ? ORDER BY rank, rowid LIMIT 5",
        (query,),
    ).fetchall()


def check_candidates(results, scope, as_of, sources):
    for file, _ in results:
        doc = sources[file]
        if doc["access"] != "public" and doc["access"] != scope:
            raise ValueError(f"超出阅读权限：{file}")
        if as_of < doc["validFrom"] or (doc["validUntil"] and as_of >= doc["validUntil"]):
            raise ValueError(f"来源在评测日期无效：{file}")


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    sources = {doc["file"]: doc for doc in manifest["documents"]}
    lines = (ROOT / "cases.jsonl").read_text(encoding="utf-8").splitlines()
    cases = [json.loads(line) for line in lines]
    answerable = top_five_hits = top_one_hits = unanswerable = with_candidates = 0
    missed_first = []
    misses = []
    for scope in sorted({case["scope"] for case in cases}):
        with closing(sqlite3.connect(":memory:")) as db:
            index(db, manifest, scope)
            for case in (item for item in cases if item["scope"] == scope):
                results = search(db, case["question"])
                check_candidates(results, scope, manifest["asOf"], sources)
                evidence = case["evidence"]
                if evidence is None:
                    unanswerable += 1
                    with_candidates += bool(results)
                else:
                    answerable += 1
                    citation = (evidence["file"], evidence["line"])
                    if results and results[0] == citation:
                        top_one_hits += 1
                    else:
                        missed_first.append(case["id"])
                    if citation in results:
                        top_five_hits += 1
                    else:
                        misses.append(case["id"])
    report = {
        "method": "fts5-bm25",
        "answerable": answerable,
        "top1Hits": top_one_hits,
        "top5Hits": top_five_hits,
        "missedTop1": missed_first,
        "missedTop5": misses,
        "unanswerable": unanswerable,
        "unanswerableWithCandidates": with_candidates,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
