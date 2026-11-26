"""检查本体服务就绪并通过标准 MCP 读取已知对象。"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from installed_acceptance import call


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8879/mcp")
    parser.add_argument("--resource", default="urn:doc:guide")
    args = parser.parse_args()
    endpoint = urlsplit(args.url)
    if (
        endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1" or endpoint.path != "/mcp"
        or endpoint.username or endpoint.password or endpoint.query or endpoint.fragment
    ):
        parser.error("请使用无凭据、查询或片段的本地 127.0.0.1 HTTP MCP 地址")
    token = os.environ.get("COREMIND_ONTOLOGY_AUTHORIZATION", "")
    if not token.startswith("Bearer ") or not token[7:].strip():
        parser.error("请设置 COREMIND_ONTOLOGY_AUTHORIZATION 为完整的 Bearer 读令牌")
    with httpx.Client(trust_env=False, timeout=5) as client:
        health = client.get(args.url.removesuffix("/mcp") + "/health", headers={"Authorization": token})
        health.raise_for_status()
        if health.json().get("status") != "ready":
            raise SystemExit("本体服务未就绪")
    result = asyncio.run(call(args.url, token, "describe", resource=args.resource))
    if result.get("status") != "available" or result.get("found") is not True or not result.get("bundleDigest"):
        raise SystemExit("本体查询没有返回可用对象及模型摘要")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
