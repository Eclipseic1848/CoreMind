from __future__ import annotations

import argparse
import re
import zipfile
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="检查 CoreMind Python wheel 发布内容")
    parser.add_argument("wheel", type=Path)
    args = parser.parse_args()
    wheel = args.wheel.resolve()
    if not wheel.is_file() or wheel.suffix != ".whl":
        raise SystemExit(f"wheel 不存在：{wheel}")

    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        metadata_name = next((name for name in names if name.endswith(".dist-info/METADATA")), None)
        worker_name = "coremind/_worker/coremind-worker.mjs"
        blockers: list[str] = []
        if metadata_name is None:
            blockers.append("缺少 METADATA")
        else:
            metadata = archive.read(metadata_name).decode("utf-8", errors="strict")
            if "License-Expression: MIT" not in metadata:
                blockers.append("METADATA 缺少 MIT License-Expression")
        if worker_name not in names:
            blockers.append("缺少内置 Node worker")
        forbidden_entry = re.compile(r"(^|/)(__pycache__|tests?|\.git|\.env)(/|$)|\.pyc$", re.I)
        bad_entries = [name for name in names if forbidden_entry.search(name)]
        if bad_entries:
            blockers.append(f"包含不应发布的文件：{', '.join(bad_entries)}")

        workstation_markers = ("F:\\new branch\\CoreMind", "F:/new branch/CoreMind", "C:\\Users\\55672", "C:/Users/55672")
        for name in names:
            if name.endswith((".md", ".mjs", ".py", "METADATA")):
                text = archive.read(name).decode("utf-8", errors="strict")
                if any(marker in text for marker in workstation_markers):
                    blockers.append(f"{name} 包含本机绝对路径")

    if blockers:
        raise SystemExit("wheel 预检失败：\n- " + "\n- ".join(blockers))
    print(f"wheel 预检通过：{wheel.name}，{len(names)} 个条目")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
