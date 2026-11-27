"""在新生成的资料上验证真实检索、授权、版本和撤回。"""

import argparse
from datetime import date, timedelta
import json
from pathlib import Path
import random
import sys
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "components/knowledge/src"))
from coremind_knowledge_mcp.catalog import KnowledgeCatalog
from coremind_knowledge_mcp.retrieval import KnowledgeIndex


def generate(seed):
    rng = random.Random(seed)
    places = rng.sample(["玉竹", "晴川", "红棉", "银沙", "蓝田", "碧水", "流萤", "月桂", "南桥"], 7)
    names = rng.sample(["票根", "谱本", "名录", "图卷", "卡片", "底片", "剪报", "手稿", "册页"], 7)
    facts = []
    target_ids = []
    for number, (place, name) in enumerate(zip(places, names)):
        code = f"ST-{rng.randrange(10000, 99999)}-{number}"
        scope = "public" if number == 6 else f"reader-{number % 3}"
        cutoff = (date(2026, 7, 1) + timedelta(days=rng.randrange(90))).isoformat()
        if scope != "public":
            target_ids.append(code)
        for version in (1, 2):
            office = f"{place}台-{rng.randrange(10, 99)}"
            facts.append({
                "id": code, "name": name, "office": office, "version": version, "scope": scope,
                "file": f"{code}-v{version}.md", "cutoff": cutoff,
            })
    # 同范围加入名称相同、编号相似的资料。目标与干扰项要靠检索排序区分。
    for fact in list(facts):
        if fact["scope"] == "public":
            continue
        for offset in (10, 20, 30):
            prefix, serial = fact["id"].rsplit("-", 1)
            code = f"{prefix}-{int(serial) + offset}"
            facts.append({
                **fact, "id": code, "file": f"{code}-v{fact['version']}.md",
                "office": f"西厅-{rng.randrange(10, 99)}",
            })
    return facts, target_ids


def source(fact):
    first = fact["version"] == 1
    return {
        "docId": fact["id"], "version": fact["version"], "file": fact["file"],
        "access": fact["scope"], "validFrom": "2020-01-01" if first else fact["cutoff"],
        "validUntil": fact["cutoff"] if first else None,
        "chunks": [{"line": 2, "text": f"{fact['id']} {fact['name']}的受理窗口为{fact['office']}。"}],
    }


def evaluate(seed, model):
    facts, target_ids = generate(seed)
    by_key = {(fact["id"], fact["version"]): fact for fact in facts}
    current = [by_key[code, 2] for code in target_ids]
    templates = [
        "{code} 的{name}去哪个台办理？", "想交{name}（{code}），该去哪个窗口？",
        "麻烦查一下编号 {code} 所对应的受理地点。", "{name}编号为{code}，受理台叫什么？",
        "查询 {code} 的办理窗口，并给出出处。", "哪一处窗口接收资料 {code}？",
    ]
    categories = ["paraphrase", "scope-denied", "effective-date", "scope-and-date", "no-evidence", "withdrawn"]
    withdrawn = set()
    rows = []
    index = KnowledgeIndex(model)
    try:
        catalog = KnowledgeCatalog(index)
        catalog.import_documents([source(fact) for fact in facts])
        for category in categories:
            for number, fact in enumerate(current):
                day = date.fromisoformat(fact["cutoff"])
                scope = fact["scope"]
                code = fact["id"]
                version = 2
                expected = {"retrievedTarget": True, "resolution": "available", "unavailableCitations": []}
                if category == "scope-denied":
                    scope = "public"
                    expected.update(retrievedTarget=False, resolution="unknown")
                if category in ("effective-date", "scope-and-date"):
                    # 半开区间交界处：前一天读旧版，起始日读新版。
                    if number % 2 == 0:
                        day -= timedelta(days=1)
                        version = 1
                    if category == "scope-and-date":
                        if number % 3 == 0:
                            scope = "unassigned-reader"
                        else:
                            version = 3 - version
                        expected.update(retrievedTarget=False, resolution="unknown")
                if category == "no-evidence":
                    code = f"unassigned-{code}"
                    expected.update(retrievedTarget=False, resolution="unknown")
                if category == "withdrawn":
                    catalog.withdraw(code, version)
                    withdrawn.add((code, version))
                    expected.update(retrievedTarget=False, resolution="withdrawn")
                # 可回答题必须首条命中。其余用例要求前五条内没有该受限、失效或不存在的版本。
                expected["targetRank"] = 1 if expected["retrievedTarget"] else None
                query = templates[(number + categories.index(category)) % len(templates)].format(code=code, name=fact["name"])
                input_data = {"query": query, "scope": scope, "asOf": str(day), "target": [code, version]}
                if category == "withdrawn":
                    input_data["withdraw"] = [code, version]
                start = perf_counter()
                observed = []
                try:
                    observed = catalog.search(query, scope=scope, as_of=str(day))
                    resolved = catalog.resolve(code, version, f"{code}-v{version}.md", line=2, scope=scope, as_of=str(day))
                    known = by_key.get((code, version))
                    rank = next((n for n, row in enumerate(observed, start=1)
                                 if known and row["docId"] == code and row["version"] == version
                                 and row["line"] == 2 and row["file"] == known["file"]
                                 and known["office"] in row["text"]), None)
                    # 判据只使用生成的业务事实、宿主身份和可见日期；检索器只收到资料与问题。
                    unavailable = []
                    for row in observed:
                        row_key = (row["docId"], row["version"])
                        candidate = by_key.get(row_key)
                        if (candidate is None or candidate["scope"] not in (scope, "public")
                                or row_key in withdrawn
                                or candidate["version"] != (1 if str(day) < candidate["cutoff"] else 2)):
                            unavailable.append(row["file"])
                    actual = {"retrievedTarget": rank is not None, "targetRank": rank,
                              "resolution": resolved["status"], "unavailableCitations": unavailable}
                except Exception as error:
                    actual = {"error": type(error).__name__, "message": str(error)}
                rows.append({
                    "id": f"knowledge/{category}/{number + 1}", "type": "knowledge.retrieval",
                    "category": category, "input": input_data, "expected": expected, "actual": actual,
                    "candidateCount": len(observed),
                    "rankedCitations": [{"file": row["file"], "line": row["line"]} for row in observed],
                    "passed": actual == expected,
                    "durationMs": round((perf_counter() - start) * 1000, 3),
                })
    finally:
        index.close()
    return rows


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(evaluate(args.seed, args.model_dir), ensure_ascii=False))
