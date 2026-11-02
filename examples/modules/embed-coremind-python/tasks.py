"""离线同步/异步任务：A 保存结果与等待、真实 Worker 重启、唤醒后 B 复用结果。"""

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient


async def demonstrate(asynchronous):
    with tempfile.TemporaryDirectory(prefix="coremind-task-example-") as workspace:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("请先安装受支持的 Node.js")
        options = {"config": {"schemaVersion": 2, "name": "离线任务", "agents": {"main": {}},
                              "permissions": {"mode": "ask", "workspaceOnly": True, "network": "deny"},
                              "runtime": {"maxToolCalls": 1, "maxRetries": 0},
                              "provider": {"id": "example", "model": "unused", "baseUrl": "http://127.0.0.1:1/v1", "apiKeyEnv": "COREMIND_TASK_EXAMPLE_KEY"}},
                   "config_dir": workspace, "cwd": workspace, "session_id": "example",
                   "protocol_version": "2.0", "request_timeout": 10,
                   "worker_command": [node, str(Path(__file__).with_name("task-host.mjs")), workspace]}
        kind = AsyncCoreMindClient if asynchronous else CoreMindClient
        async def call(client, name, *args):
            return await getattr(client, name)(*args) if asynchronous else getattr(client, name)(*args)
        first = kind(**options)
        try:
            await call(first, "task_start", "job", "example", 0)
            sleeping = (await call(first, "task_resume", "job"))["task"]
            assert sleeping["status"] == "sleeping"
            saved = await call(first, "task_calls", "job")
            assert len(saved["calls"]) == 1
            assert saved["calls"][0]["key"] == "record"
            assert saved["calls"][0]["status"] == "completed"
            assert saved["calls"][0]["result"]["details"]["value"] == sleeping["checkpoint"] == 1
        finally:
            await call(first, "close")
        second = kind(**options)
        try:
            assert (await call(second, "task_query", "job"))["task"] == sleeping
            assert await call(second, "task_calls", "job") == saved
            pids = (Path(workspace) / "worker-pids.txt").read_text(encoding="utf-8").splitlines()
            assert len(pids) == 2 and pids[0] != pids[1]
            deadline = (await call(second, "task_next_wake"))["deadline"]
            assert deadline["taskId"] == "job" and deadline["sleepId"] == sleeping["sleep"]["sleepId"]
            assert (await call(second, "task_wake", "job", "notification-1", deadline["sleepId"]))["wakeStatus"] == "accepted"
            done = (await call(second, "task_resume", "job"))["task"]
            assert done["status"] == "completed" and done["checkpoint"] == 2
            assert await call(second, "task_calls", "job") == saved
            executions = (Path(workspace) / "canary.txt").read_text(encoding="utf-8").splitlines()
            assert len(executions) == 1 and executions[0].startswith(pids[0] + ":")
            await call(second, "task_start", "cancelled", "example", 0)
            assert (await call(second, "task_cancel", "cancelled"))["task"]["status"] == "cancelled"
            print(("async" if asynchronous else "sync") + ": task restart/wake/result reuse/cancel OK; "
                  + f"pids={pids}, runId={saved['calls'][0]['runId']}, executions=1, checkpoint=2")
        finally:
            await call(second, "close")


if __name__ == "__main__":
    os.environ["COREMIND_TASK_EXAMPLE_KEY"] = "offline-test-only"
    asyncio.run(demonstrate(False))
    asyncio.run(demonstrate(True))
