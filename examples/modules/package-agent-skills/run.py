"""同一 Skill 任务的 Python 同步与异步入口。"""

import argparse
import asyncio
import shutil
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient

WORKER = Path(__file__).resolve().parents[3] / "packages" / "coremind-worker" / "dist" / "stdio.js"


async def run_async(config, prompt, worker_command):
    async with AsyncCoreMindClient(config, worker_command=worker_command) as client:
        return await client.run(prompt)


def run(config, prompt, asynchronous):
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("找不到 Node.js")
    worker_command = [node, str(WORKER)]
    if asynchronous:
        return asyncio.run(run_async(config, prompt, worker_command))
    with CoreMindClient(config, worker_command=worker_command) as client:
        return client.run(prompt)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("prompt")
    parser.add_argument("--async", action="store_true", dest="asynchronous")
    args = parser.parse_args()
    result = run(args.config.resolve(), args.prompt, args.asynchronous)
    if result["outcome"]["status"] != "succeeded":
        raise RuntimeError(result["outcome"])
    print(result["transcript"])
