"""离线同步/异步任务示例：阶段 A、关闭进程、重开、显式唤醒、阶段 B。"""

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
                              "provider": {"id": "example", "model": "unused", "baseUrl": "http://127.0.0.1:1/v1", "apiKeyEnv": "COREMIND_TASK_EXAMPLE_KEY"}},
                   "config_dir": workspace, "cwd": workspace, "session_id": "example",
                   "protocol_version": "2.0", "request_timeout": 10,
                   "worker_command": [node, str(Path(__file__).with_name("task-host.mjs"))]}
        kind = AsyncCoreMindClient if asynchronous else CoreMindClient
        async def call(client, name, *args):
            return await getattr(client, name)(*args) if asynchronous else getattr(client, name)(*args)
        first = kind(**options)
        try:
            await call(first, "task_start", "job", "example", 0)
            sleeping = (await call(first, "task_resume", "job"))["task"]
            assert sleeping["status"] == "sleeping"
        finally:
            await call(first, "close")
        second = kind(**options)
        try:
            assert (await call(second, "task_query", "job"))["task"] == sleeping
            deadline = (await call(second, "task_next_wake"))["deadline"]
            await call(second, "task_wake", "job", "notification-1", deadline["sleepId"])
            done = (await call(second, "task_resume", "job"))["task"]
            assert done["status"] == "completed" and done["checkpoint"] == 2
            await call(second, "task_start", "cancelled", "example", 0)
            assert (await call(second, "task_cancel", "cancelled"))["task"]["status"] == "cancelled"
            print(("async" if asynchronous else "sync") + ": task restart/wake/cancel OK")
        finally:
            await call(second, "close")


if __name__ == "__main__":
    os.environ["COREMIND_TASK_EXAMPLE_KEY"] = "offline-test-only"
    asyncio.run(demonstrate(False))
    asyncio.run(demonstrate(True))
