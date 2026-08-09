"""Python SDK + callable 工具黄金示例。"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from coremind import CoreMindClient


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def analyze_sales_file(
    csv_path: str,
    project_root: Path = PROJECT_ROOT,
    output_path: str = "artifacts/summary.json",
) -> dict[str, Any]:
    """读取工作区内 CSV，计算确定性汇总并写入 JSON 产物。"""

    root = project_root.resolve()
    source = (root / csv_path).resolve()
    if root != source and root not in source.parents:
        raise ValueError(f"CSV 路径超出项目目录：{csv_path}")
    total = 0.0
    rows = 0
    by_region: dict[str, float] = {}
    with source.open("r", encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            amount = float(row["amount"])
            total += amount
            rows += 1
            by_region[row["region"]] = by_region.get(row["region"], 0.0) + amount
    result = {"rows": rows, "total": total, "byRegion": by_region}
    output = (root / output_path).resolve()
    if root != output and root not in output.parents:
        raise ValueError(f"输出路径超出项目目录：{output_path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def register_tools(client: CoreMindClient, project_root: Path = PROJECT_ROOT) -> None:
    """在 worker 启动前注册 Python callable。"""

    @client.tool(
        name="analyze_sales",
        description="分析工作区内的销售 CSV",
        effect={
            "operations": ["read", "write"],
            "reversible": False,
            "pathFields": ["csv_path", "output_path"],
        },
    )
    def analyze_sales(csv_path: str, output_path: str) -> dict[str, Any]:
        return analyze_sales_file(csv_path, project_root, output_path)


def main() -> None:
    client = CoreMindClient(
        PROJECT_ROOT / "coremind.yaml",
        cwd=PROJECT_ROOT,
        approval_handler=lambda request: "allow" if request["tool"] == "analyze_sales" else "deny",
    )
    register_tools(client)
    with client:
        result = client.run("分析 data/sales.csv，并输出总额和区域汇总")
    print(result["transcript"])


if __name__ == "__main__":
    main()
