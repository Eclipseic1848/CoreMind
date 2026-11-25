"""只用 CoreMind Python SDK 和已安装的内置 Worker。"""

import asyncio
import sys
from pathlib import Path

from coremind import AsyncCoreMindClient, CoreMindClient


async def run_async(config, prompt):
    async with AsyncCoreMindClient(config) as client:
        return await client.run(prompt)


def run(config, prompt, asynchronous):
    if asynchronous:
        return asyncio.run(run_async(config, prompt))
    with CoreMindClient(config) as client:
        return client.run(prompt)


if __name__ == "__main__":
    result = run(Path("coremind.yaml"), "请只回答 OK", "--async" in sys.argv)
    if result["outcome"]["status"] != "succeeded":
        raise RuntimeError(result["outcome"])
    print(result["transcript"])
