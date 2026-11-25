"""用 Python 同步或异步 SDK 运行相同的本体配置。"""

import argparse
import asyncio
import json
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient


ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "packages" / "coremind-worker" / "dist" / "stdio.js"


async def run_async(config, prompt):
    async with AsyncCoreMindClient(config, worker_command=["node", str(WORKER)]) as client:
        return await client.run(prompt)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("prompt")
    parser.add_argument("--async", action="store_true", dest="asynchronous")
    args = parser.parse_args()
    if args.asynchronous:
        result = asyncio.run(run_async(args.config, args.prompt))
    else:
        with CoreMindClient(args.config, worker_command=["node", str(WORKER)]) as client:
            result = client.run(args.prompt)
    if result["outcome"]["status"] != "succeeded":
        raise RuntimeError(json.dumps(result["outcome"], ensure_ascii=False))
    print(result["transcript"])
