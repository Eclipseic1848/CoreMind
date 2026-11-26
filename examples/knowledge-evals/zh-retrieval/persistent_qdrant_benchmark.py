"""在固定合成中文题集上对照内存与持久 Qdrant。"""

import argparse
import hashlib
import json
import math
import subprocess
import sys
import tempfile
from contextlib import ExitStack, contextmanager
from importlib.metadata import version
from pathlib import Path
from statistics import median
from time import perf_counter
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parents[2] / "components/knowledge/src"))

from coremind_knowledge_mcp.catalog import KnowledgeCatalog
from coremind_knowledge_mcp.retrieval import MODEL_FILES, MODEL_REVISION, KnowledgeIndex
from coremind_knowledge_mcp.server import load_corpus


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextmanager
def measure_encoding(index):
    original = index._encode
    result = {"encodedBlocks": 0}

    def encode(texts):
        result["encodedBlocks"] += len(texts)
        return original(texts)

    start = perf_counter()
    with patch.object(index, "_encode", encode):
        yield result
    result["milliseconds"] = round((perf_counter() - start) * 1000, 3)


@contextmanager
def site(model_dir, project, mode, records=()):
    start = perf_counter()
    index_dir = project / "qdrant" if mode == "persistent" else None
    index = KnowledgeIndex(model_dir, index_dir=index_dir)
    try:
        with measure_encoding(index) as projection:
            catalog = KnowledgeCatalog(index, project / "catalog.json")
            imported = catalog.import_documents(records)
        ready = {
            "readyMs": round((perf_counter() - start) * 1000, 3),
            "projection": projection,
            **imported,
        }
        yield index, catalog, ready
    finally:
        index.close()


def start_in_child(model_dir, project, mode, stage):
    command = [
        sys.executable, "-B", "-X", "utf8", str(Path(__file__).resolve()),
        "--model-dir", str(model_dir), "--stage", stage, "--project", str(project),
        "--mode", mode,
    ]
    start = perf_counter()
    result = subprocess.run(command, capture_output=True, encoding="utf-8", timeout=180)
    if result.returncode:
        print(result.stderr, file=sys.stderr, end="")
        result.check_returncode()
    report = json.loads(result.stdout)
    report["processElapsedMs"] = round((perf_counter() - start) * 1000, 3)
    return report


def scored_queries(catalogs, cases, documents, day):
    rows = {mode: [] for mode in catalogs}
    agreed = 0
    ranks = []
    unsupported = 0
    unsupported_with_candidates = 0
    for repeat in range(4):
        for i, case in enumerate(cases):
            order = tuple(catalogs) if (repeat + i) % 2 == 0 else tuple(reversed(catalogs))
            hits = {}
            for mode in order:
                start = perf_counter()
                hits[mode] = catalogs[mode].search(case["question"], scope=case["scope"], as_of=day)
                elapsed = perf_counter() - start
                if repeat:
                    rows[mode].append(elapsed * 1000)
            assert hits["memory"] == hits["persistent"], case["id"]
            if repeat:
                agreed += 1
                continue
            candidates = hits["memory"]
            positions = []
            for hit in candidates:
                record = documents[hit["file"]]
                assert (hit["docId"], hit["version"]) == (record["docId"], record["version"])
                assert hit["access"] == record["access"] and hit["access"] in {"public", case["scope"]}
                assert hit["validFrom"] == record["validFrom"] and hit["validFrom"] <= day
                assert hit["validUntil"] == record["validUntil"]
                assert hit["validUntil"] is None or day < hit["validUntil"]
                position = hit["file"], hit["line"]
                positions.append(position)
                for catalog in catalogs.values():
                    citation = catalog.resolve(
                        hit["docId"], hit["version"], *position, scope=case["scope"], as_of=day,
                    )
                    assert citation["status"] == "available" and citation["text"] == hit["text"]
                    assert citation.get("tableHeader") == hit.get("tableHeader")
            gold = case["evidence"]
            if gold is not None:
                expected = gold["file"], gold["line"]
                ranks.append(positions.index(expected) + 1 if expected in positions else None)
                if expected in positions:
                    assert gold["quote"] in candidates[positions.index(expected)]["text"]
            else:
                unsupported += 1
                unsupported_with_candidates += bool(candidates)
    assert len(ranks) == ranks.count(1) == 30 and unsupported == 10
    return {
        "goldCases": len(ranks),
        "top1": ranks.count(1),
        "top5": sum(rank is not None for rank in ranks),
        "unanswerableCases": unsupported,
        "unanswerableWithCandidates": unsupported_with_candidates,
        "orderedResponsesEqual": agreed,
        "sparseQueryMs": {
            name: {
                "p50": round(median(values), 3),
                "p95": round(sorted(values)[math.ceil(len(values) * 0.95) - 1], 3),
            }
            for name, values in rows.items()
        },
    }


def changed_document(project, original, gold, day, new_version, marker):
    source = {
        "id": original["docId"], "version": new_version, "access": original["access"],
        "validFrom": original["validFrom"], "validUntil": original["validUntil"],
        "file": f"{original['docId']}-v{new_version}.md",
    }
    folder = project / f"revision-{new_version}"
    (folder / "sources").mkdir(parents=True)
    lines = (ROOT / "sources" / original["file"]).read_text(encoding="utf-8").splitlines()
    lines[gold["line"] - 1] += f"。{marker}"
    (folder / "sources" / source["file"]).write_text("\n".join(lines) + "\n", encoding="utf-8")
    manifest = folder / "manifest.json"
    manifest.write_text(json.dumps({"asOf": day, "documents": [source]}, ensure_ascii=False), encoding="utf-8")
    return load_corpus(manifest)[1][0]


def mutations(model_dir, project, mode, original, gold, private, private_case, day):
    marker = "持久索引变更验收"
    replacement = changed_document(project, original, gold, day, original["version"] + 1, marker)
    invalid = changed_document(project, original, gold, day, original["version"] + 2, "禁止发布的故障夹具")
    state = project / "catalog.json"

    def resolve(catalog, doc, line, scope):
        return catalog.resolve(doc["docId"], doc["version"], doc["file"], line, scope=scope, as_of=day)

    def search(catalog):
        return catalog.search(marker, scope="public", as_of=day)

    old_key = original["docId"], original["version"]
    with site(model_dir, project, mode) as (index, catalog, _):
        with measure_encoding(index) as update:
            catalog.import_documents([replacement], withdrawals=[old_key])
        assert resolve(catalog, original, gold["line"], "public")["status"] == "withdrawn"
        assert marker in resolve(catalog, replacement, gold["line"], "public")["text"]
        assert any(hit["file"] == replacement["file"] for hit in search(catalog))

        private_key = private["docId"], private["version"]
        private_line = private_case["evidence"]["line"]
        assert resolve(catalog, private, private_line, "desk")["status"] == "available"
        assert resolve(catalog, private, private_line, "public")["status"] == "unknown"
        with measure_encoding(index) as withdraw:
            catalog.withdraw(*private_key)
        assert resolve(catalog, private, private_line, "desk")["status"] == "withdrawn"
        assert all(
            (hit["docId"], hit["version"]) != private_key
            for hit in catalog.search(private_case["question"], scope="desk", as_of=day)
        )

        committed = sha256(state)
        expected_hits = search(catalog)
        with measure_encoding(index) as failed, patch.object(catalog, "_save", side_effect=OSError("评测落盘故障")):
            try:
                catalog.import_documents([invalid], withdrawals=[(replacement["docId"], replacement["version"])])
            except OSError as exc:
                assert str(exc) == "评测落盘故障"
            else:
                raise AssertionError("落盘故障应阻止发布")
        assert sha256(state) == committed and search(catalog) == expected_hits
    with site(model_dir, project, mode) as (_, recovered, reopened):
        assert sha256(state) == committed and search(recovered) == expected_hits
        assert resolve(recovered, invalid, gold["line"], "public")["status"] == "unknown"
        assert resolve(recovered, replacement, gold["line"], "public")["status"] == "available"
        assert resolve(recovered, private, private_line, "desk")["status"] == "withdrawn"
    return {
        "singleDocumentChangedBlocks": 1,
        "singleDocumentBlocks": len(replacement["chunks"]),
        "singleDocumentUpdate": update,
        "withdraw": withdraw,
        "failedSave": failed,
        "restartAfterFailure": reopened,
        "catalogUnchangedAfterFailure": True,
    }


def evaluate(model_dir, workspace):
    fixture = ROOT / "manifest.json"
    labels = ROOT / "cases.jsonl"
    day, records = load_corpus(fixture)
    cases = [json.loads(row) for row in labels.read_text(encoding="utf-8").splitlines()]
    by_file = {doc["file"]: doc for doc in records}
    modes = {name: workspace / name for name in ("memory", "persistent")}
    results = {}
    for mode, project in modes.items():
        project.mkdir()
        results[mode] = {
            stage: start_in_child(model_dir, project, mode, stage) for stage in ("create", "reopen")
        }
    with ExitStack() as stack:
        catalogs = {mode: stack.enter_context(site(model_dir, project, mode))[1] for mode, project in modes.items()}
        query = scored_queries(catalogs, cases, by_file, day)
    sample = next(case["evidence"] for case in cases if case["evidence"] and case["evidence"]["file"] == "资料室手册-v2.md")
    private = next(case for case in cases if case["evidence"] and by_file[case["evidence"]["file"]]["access"] == "desk")
    for mode, project in modes.items():
        results[mode]["mutations"] = mutations(
            model_dir, project, mode, by_file[sample["file"]], sample, by_file[private["evidence"]["file"]], private, day,
        )
        results[mode]["catalogBytes"] = (project / "catalog.json").stat().st_size
        results[mode]["indexBytes"] = sum(
            path.stat().st_size for path in (project / "qdrant").rglob("*") if path.is_file()
        )
    return {
        "versions": {name: version(name) for name in ("qdrant-client", "numpy", "onnxruntime", "tokenizers")},
        "modelRevision": MODEL_REVISION,
        "modelSha256": MODEL_FILES,
        "manifestSha256": sha256(fixture),
        "casesSha256": sha256(labels),
        "documents": len(records),
        "initialBlocks": sum(len(doc["chunks"]) for doc in records),
        "results": results,
        "query": query,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--stage", choices=("create", "reopen"), help=argparse.SUPPRESS)
    parser.add_argument("--project", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--mode", choices=("memory", "persistent"), help=argparse.SUPPRESS)
    args = parser.parse_args()
    model_dir = args.model_dir.resolve()
    if args.stage:
        _, records = load_corpus(ROOT / "manifest.json")
        with site(model_dir, args.project, args.mode, records) as (_, _, ready):
            assert ready["imported"] == (len(records) if args.stage == "create" else 0)
            print(json.dumps(ready, ensure_ascii=False))
        return
    with tempfile.TemporaryDirectory(prefix="coremind-persistent-qdrant-") as tmp:
        result = evaluate(model_dir, Path(tmp))
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8")
    print(output, end="")


if __name__ == "__main__":
    main()
