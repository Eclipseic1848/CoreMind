"""普通 MCP 客户端查询示例，读者权限由服务配置决定。"""

import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main(query):
    url = os.environ.get("KNOWLEDGE_MCP_URL", "http://127.0.0.1:8767/mcp")
    headers = {"Authorization": os.environ["COREMIND_KNOWLEDGE_AUTHORIZATION"]}
    async with httpx.AsyncClient(headers=headers, trust_env=False) as http:
        async with streamable_http_client(url, http_client=http) as (reader, writer, _):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                result = await session.call_tool("search_knowledge", {"query": query})
                if result.isError:
                    raise RuntimeError(result.content[0].text)
                citations = json.loads(result.content[0].text)["citations"]
                for citation in citations:
                    position = next(key for key in ("chunkId", "line", "locator") if citation.get(key) is not None)
                    location = {key: citation[key] for key in ("docId", "version", "file", position)}
                    resolved = await session.call_tool("resolve_citation", location)
                    if resolved.isError:
                        raise RuntimeError(resolved.content[0].text)
                    original = json.loads(resolved.content[0].text)
                    if original["status"] != "available" or original.get("text") != citation["text"]:
                        raise RuntimeError("回查原文与检索片段不一致：" + resolved.content[0].text)
                    print(resolved.content[0].text)
                if not citations:
                    print("当前读者没有匹配的资料")


if __name__ == "__main__":
    asyncio.run(main(" ".join(sys.argv[1:]) or "松纹卡的办理窗口"))
