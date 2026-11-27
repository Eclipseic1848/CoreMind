"""用当前工作区的 Python SDK、Node Worker 和黄金示例工具执行一批独立的 CSV 输入。"""

import importlib.util
import json
import sys
import tempfile
import time
from contextlib import nullcontext
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[3]
    sys.path.insert(0, str(root / "python" / "src"))
    from coremind import CoreMindClient

    spec = importlib.util.spec_from_file_location(
        "sales_example", root / "examples/golden/python-data-analysis/src/main.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    batch = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    results = []
    workspace = batch.get("workspace")
    location = nullcontext(workspace) if workspace else tempfile.TemporaryDirectory(prefix="coremind-business-sales-")
    with location as directory:
        work = Path(directory)
        source = work / "data" / "sales.csv"
        source.parent.mkdir(exist_ok=True)
        artifact = None

        def approve(request):
            nonlocal artifact
            args = request.get("args", {})
            if request["tool"] != "analyze_sales" or not all(isinstance(args.get(k), str) for k in ("csv_path", "output_path")):
                return "deny"
            target = (work / args["output_path"]).resolve()
            if (work / args["csv_path"]).resolve() != source or not target.is_relative_to(work):
                return "deny"
            if target.suffix.lower() != ".json" or any(part.startswith(".") for part in target.relative_to(work).parts):
                return "deny"
            artifact = target
            return "allow"

        client = CoreMindClient(
            batch["config"], config_dir=work, cwd=work,
            worker_command=[batch["node"], str(root / "packages/coremind-worker/dist/stdio.js")],
            approval_handler=approve,
        )
        module.register_tools(client, work)
        with client:
            for case in batch["cases"]:
                with source.open("w", encoding="utf-8", newline="") as handle:
                    handle.write(case["csv"])
                if artifact:
                    artifact.unlink(missing_ok=True)
                artifact = None
                start = time.perf_counter()
                try:
                    run = client.run(case["prompt"])
                    row = {
                        "status": run["outcome"]["status"], "transcript": run["transcript"],
                        "runId": run["runId"], "toolCalls": run["metrics"]["toolCalls"],
                        "toolFailures": run["metrics"]["toolFailures"],
                    }
                    if workspace:
                        row["run"] = run
                except Exception as exc:
                    row = {"status": "error", "error": str(exc), "toolFailures": 0}
                row["artifact"] = None
                if artifact and artifact.exists():
                    row["artifactPath"] = artifact.relative_to(work).as_posix()
                    content = artifact.read_text(encoding="utf-8")
                    try:
                        row["artifact"] = json.loads(content, parse_constant=invalid_constant)
                    except ValueError as exc:
                        row["artifact"] = {"invalidJson": str(exc), "text": content}
                row["durationMs"] = round((time.perf_counter() - start) * 1000)
                results.append(row)
    sys.stdout.buffer.write(json.dumps(results, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def invalid_constant(value):
    raise ValueError(f"无效 JSON 数值：{value}")


if __name__ == "__main__":
    main()
