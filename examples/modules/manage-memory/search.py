"""同一 CoreMind 配置下的 Python 同步和异步记忆查询。"""

import argparse
import asyncio
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "packages" / "coremind-worker" / "dist" / "stdio.js"


async def search_async(config, query):
    async with AsyncCoreMindClient(config, worker_command=["node", str(WORKER)]) as client:
        return await client.run(query)


def search(config, query, asynchronous):
    if asynchronous:
        return asyncio.run(search_async(config, query))
    with CoreMindClient(config, worker_command=["node", str(WORKER)]) as client:
        return client.run(query)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("query")
    parser.add_argument("--async", action="store_true", dest="asynchronous")
    args = parser.parse_args()
    result = search(args.config, args.query, args.asynchronous)
    if result["outcome"]["status"] != "succeeded":
        raise RuntimeError(result["outcome"])
    print(result["transcript"])
