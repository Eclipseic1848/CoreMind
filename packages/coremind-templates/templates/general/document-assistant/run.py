"""通过同步或异步 SDK 运行资料整理任务。"""

import argparse
import asyncio
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient


def approve(event):
    args = event.get("args", {})
    return "allow" if event["tool"] == "write" and args.get("path") == "summary.md" else "deny"


async def run_async(config, prompt):
    async with AsyncCoreMindClient(config, cwd=config.parent, approval_handler=approve) as client:
        return await client.run(prompt)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("prompt")
    parser.add_argument("--async", action="store_true", dest="asynchronous")
    args = parser.parse_args()
    config = args.config.resolve()
    if args.asynchronous:
        result = asyncio.run(run_async(config, args.prompt))
    else:
        with CoreMindClient(config, cwd=config.parent, approval_handler=approve) as client:
            result = client.run(args.prompt)
    if result["outcome"]["status"] != "succeeded":
        raise RuntimeError(result["outcome"])
    print(result["transcript"])
