"""将固定三轮原始问题送入知识检索，单独计量可见证据与撤回结果。"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CORPUS = ROOT / "examples/knowledge-evals/zh-retrieval"
sys.path.insert(0, str(ROOT / "components/knowledge/src"))

from coremind_knowledge_mcp.catalog import KnowledgeCatalog
from coremind_knowledge_mcp.retrieval import KnowledgeIndex
from coremind_knowledge_mcp.server import load_corpus


def evaluate(model_dir):
    fixture = json.loads((CORPUS / "organize-materials.json").read_text(encoding="utf-8"))
    as_of, records = load_corpus(CORPUS / "manifest.json")
    by_file = {record["file"]: record for record in records}
    withdrawn = set()
    rounds = []
    index = KnowledgeIndex(model_dir)
    try:
        for item in fixture["rounds"]:
            # 每轮仅向索引提供宿主列出的来源。实际检索仍检查文档有效期与读者范围。
            catalog = KnowledgeCatalog(index)
            catalog.import_documents([by_file[name] for name in item["sources"] if name not in withdrawn])
            results = catalog.search(item["input"], scope=fixture["scope"], as_of=as_of)
            expected = item["expected"]
            citations = {}
            for field in ("evidence", "historicalRows"):
                if field in expected:
                    citations[field] = [
                        {
                            "file": ref["file"], "line": ref["line"],
                            "found": any(row["file"] == ref["file"] and row["line"] == ref["line"]
                                         and ref["quote"] in row["text"] for row in results),
                        }
                        for ref in expected[field]
                    ]
            changes = []
            for action in item.get("after", []):
                if "withdraw" in action:
                    filename = action["withdraw"]
                    record = by_file[filename]
                    catalog.withdraw(record["docId"], record["version"])
                    status = catalog.resolve(record["docId"], record["version"], filename,
                                             scope=fixture["scope"], as_of=as_of)["status"]
                    if status != "withdrawn":
                        raise AssertionError(f"撤回后仍可用：{filename}")
                    withdrawn.add(filename)
                    changes.append({"withdraw": filename, "resolveStatus": status})
                else:
                    changes.append({"unverified": sorted(set(action) - {"input"})})
            rounds.append({
                "session": item["session"], "input": item["input"], "sources": item["sources"],
                "retrieved": [{"file": row["file"], "line": row["line"]} for row in results],
                "citationCoverage": citations, "after": changes,
                "unverifiedExpectedFields": sorted(set(expected) - set(citations)),
            })
    finally:
        index.close()
    return {
        "mode": "component-retrieval", "rounds": rounds, "asOf": as_of,
        "unverified": {"entrypoints": fixture["entrypoints"], "ontology": list(fixture["ontology"])},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = evaluate(args.model_dir)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"roundsExecuted": len(result["rounds"]), "mode": result["mode"]}))
