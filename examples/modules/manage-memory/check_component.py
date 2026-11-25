"""在宿主分配的两个测试库上核对独立安装的网关。"""
import argparse
import asyncio
import json
import os
import uuid
from datetime import date, timedelta

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def recall(url, reader, query):
    async with httpx.AsyncClient(headers={"Authorization": reader}, timeout=60) as http:
        async with streamable_http_client(url + "/mcp", http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = [tool.name for tool in (await session.list_tools()).tools]
                assert names == ["recall_memory"], names
                result = await session.call_tool("recall_memory", {"query": query})
                assert not result.isError, result.content
                return json.loads(result.content[0].text)["memories"]


async def check(url, bank):
    reader = os.environ["COREMIND_MEMORY_AUTHORIZATION"]
    other = os.environ["COREMIND_MEMORY_OTHER_AUTHORIZATION"]
    admin = os.environ["COREMIND_MEMORY_ADMIN_AUTHORIZATION"]
    assert len({reader, other, admin}) == 3, "验收需要三个独立凭据"
    document = "check-" + uuid.uuid4().hex
    expired = document + "-expired"
    query = "资料摘要采用什么格式？"
    today = date.today()
    original = dict(bankId=bank, documentId=document, expectedVersion=0, text="资料摘要优先使用表格。",
                    source="example:host-confirmed", occurredAt=str(today), kind="fact")
    corrected = dict(original, expectedVersion=1, text="资料摘要优先使用清单。", source="example:correction")
    target = {"bankId": bank, "documentId": document}
    async with httpx.AsyncClient(base_url=url, headers={"Authorization": admin}, timeout=120) as host:
        async def post(action, body):
            reply = await host.post("/admin/" + action, json=body)
            reply.raise_for_status()
            return reply.json()

        try:
            saved = await post("retain", original)
            assert saved["status"] == "active" and saved["version"] == 1
            assert saved == await post("retain", original)
            hits = [r for r in await recall(url, reader, query) if r["documentId"] == document]
            assert hits and all(r["bankId"] == bank and r["version"] == 1 and
                                r["source"]["ref"] == original["source"] for r in hits)
            assert all(r["documentId"] != document for r in await recall(url, other, query))
            assert (await post("correct", corrected))["version"] == 2
            hits = [r for r in await recall(url, reader, query) if r["documentId"] == document]
            assert hits and all(r["text"] == corrected["text"] and r["version"] == 2 for r in hits)
            stale = await host.post("/admin/correct", json=dict(corrected, text="旧写入"))
            assert stale.status_code == 409
            await post("retain", dict(original, documentId=expired, occurredAt=str(today - timedelta(days=2)),
                                      expiresAt=str(today - timedelta(days=1))))
            assert all(r["documentId"] != expired for r in await recall(url, reader, query))
            assert (await post("forget", target))["status"] == "forgotten"
            assert all(r["documentId"] != document for r in await recall(url, reader, query))
            replay = await host.post("/admin/retain", json=original)
            assert replay.status_code == 409
        finally:
            await post("forget", target)
            await post("forget", dict(target, documentId=expired))
    print(json.dumps({"bank": bank, "documentId": document, "revision": 2, "isolation": True,
                      "expiredHidden": True, "forgotten": True}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8769")
    parser.add_argument("--bank", required=True, help="宿主专门分配的合成测试库")
    args = parser.parse_args()
    asyncio.run(check(args.url.rstrip("/"), args.bank))
