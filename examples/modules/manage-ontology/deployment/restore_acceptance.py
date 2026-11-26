"""在新业务目录演练本体独立部署、同点备份、隔离恢复和服务回退。"""

import argparse
import asyncio
import json
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import sysconfig
import time
from contextlib import closing
from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXAMPLE))
from installed_acceptance import call, probe, service


def backup(source, snapshot):
    snapshot.mkdir()
    shutil.copytree(source / "model-v1", snapshot / "model")
    shutil.copy2(source / "receipt_handler.py", snapshot)
    # 两个独立的 SQLite 库需要在业务和服务都停止后取同点快照。
    for name in ("business.sqlite3", "action-receipts.sqlite3"):
        with (
            closing(sqlite3.connect((source / name).as_uri() + "?mode=ro", uri=True)) as original,
            closing(sqlite3.connect(snapshot / name)) as copy,
        ):
            original.backup(copy)
            assert copy.execute("PRAGMA quick_check").fetchone() == ("ok",)


async def verify(restored, console, digest):
    read, action = ("Bearer " + secrets.token_urlsafe(32) for _ in range(2))
    env = {k: v for k, v in os.environ.items() if k.upper() not in {"PYTHONPATH", "PYTHONHOME"}}
    env.update(
        COREMIND_ONTOLOGY_AUTHORIZATION=read,
        COREMIND_ONTOLOGY_ACTION_AUTHORIZATION=action,
        ONTOLOGY_BUSINESS_DB=str(restored / "business.sqlite3"),
        PYTHONNOUSERSITE="1",
    )
    start = time.monotonic()
    with service(
        console, restored, restored / "model", env, read,
        handler=restored / "observe_handler.py", journal=restored / "action-receipts.sqlite3",
    ) as (url, _):
        ready_seconds = round(time.monotonic() - start, 3)
        guide = await call(url, read, "describe", resource="urn:doc:guide")
        assert guide["status"] == "available" and guide["bundleDigest"] == digest
        assert guide["modelVersion"] == "1.0.0"
        assert any(row["predicate"] == "urn:review:state" and row["value"] == "published"
                   for row in guide["properties"])
        completed = await call(url, action, "perform_action", action="publish",
                               resource="urn:doc:guide", request_id="publish-guide")
        assert completed["status"] == "completed" and completed["replayed"]
        lost = await call(url, action, "perform_action", action="review",
                          resource="urn:doc:draft", request_id="lost")
        assert lost["status"] == "unknown" and lost["replayed"]
        retry = await call(url, action, "perform_action", action="review",
                           resource="urn:doc:draft", request_id="new-after-restore")
        assert retry["reason"] == "prior_effect_unknown"
    assert not (restored / "unexpected-action.txt").exists()
    return ready_seconds


async def exercise(project, current, replacement):
    source = project / "original"
    source.mkdir()
    digest = await probe(source, EXAMPLE / "models", EXAMPLE / "receipt_handler.py", current)
    snapshot = project / "backup"
    start = time.monotonic()
    backup(source, snapshot)
    backup_seconds = round(time.monotonic() - start, 3)
    start = time.monotonic()
    restored = Path(shutil.copytree(snapshot, project / "restored"))
    restore_seconds = round(time.monotonic() - start, 3)
    (restored / "observe_handler.py").write_text(
        'from pathlib import Path\nimport runpy\n'
        'execute_business = runpy.run_path(str(Path(__file__).with_name("receipt_handler.py")))["execute"]\n'
        'def execute(command):\n'
        '    Path(__file__).with_name("unexpected-action.txt").touch()\n'
        '    return execute_business(command)\n', encoding="utf-8",
    )
    ready = [await verify(restored, console, digest) for console in (replacement, current)]
    with closing(sqlite3.connect((restored / "business.sqlite3").as_uri() + "?mode=ro", uri=True)) as db:
        assert dict(db.execute("SELECT resource,state FROM objects")) == {
            "urn:doc:guide": "published", "urn:doc:draft": "reviewed",
        }
        assert sorted(row[0] for row in db.execute("SELECT request_id FROM receipts")) == ["lost", "publish-guide"]
    return {
        "componentVersions": ["0.1.0", "0.1.0"], "modelRollback": "1.0.0", "modelBundle": digest,
        "backupSeconds": backup_seconds, "restoreCopySeconds": restore_seconds,
        "backupBytes": sum(path.stat().st_size for path in snapshot.rglob("*") if path.is_file()),
        "replacementReadySeconds": ready[0], "rollbackReadySeconds": ready[1],
        "restoredBusinessReceipts": 2, "restoredExecutorCalls": 0, "unknownReplayBlocked": True,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, required=True, help="新建或空的隔离业务目录")
    parser.add_argument("--replacement-console", type=Path, required=True, help="另一专用环境中的本体可执行文件")
    args = parser.parse_args()
    project = args.project.resolve()
    current = (Path(sysconfig.get_path("scripts")) /
               ("coremind-ontology-mcp.exe" if os.name == "nt" else "coremind-ontology-mcp")).resolve()
    replacement = args.replacement_console.resolve(strict=True)
    if current == replacement:
        parser.error("请使用两个独立的本体服务环境")
    for console in (current, replacement):
        assert subprocess.check_output([console, "--version"], encoding="utf-8", timeout=10).strip() == "0.1.0"
    project.mkdir(parents=True, exist_ok=True)
    if any(project.iterdir()):
        parser.error("验收需要空的项目目录")
    print(json.dumps(asyncio.run(exercise(project, current, replacement)), ensure_ascii=False))


if __name__ == "__main__":
    main()
