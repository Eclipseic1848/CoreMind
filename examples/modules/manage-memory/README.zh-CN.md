# 从空白项目接入 Hindsight 记忆

宿主运行 Hindsight 和 MCP 网关；业务项目持读令牌召回已确认事实。下面从两个独立目录启动服务和标准 MCP 客户端。

## 准备服务

1. 启动 Hindsight 1.2.3，将 API 绑定到本地 `127.0.0.1:8780`。Python 3.12 可安装 `hindsight-api-slim[embedded-db,local-onnx]==1.2.3`，用 `hindsight-api --host 127.0.0.1 --port 8780` 启动。设 `HINDSIGHT_API_DATABASE_URL=pg0://coremind-memory-demo` 以隔离演示数据库。由宿主配置模型，中文召回使用适配中文的嵌入模型。设 `HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks`、`HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false`、`HINDSIGHT_API_LLM_TRACE_ENABLED=false` 和 `HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT=true`。不配置神经重排时使用 `HINDSIGHT_API_RERANKER_PROVIDER=rrf`。本地模型或代理绑定回环地址时，将 `127.0.0.1,localhost` 加入 `NO_PROXY`。[安装与部署](https://hindsight.vectorize.io/developer/installation) · [模型配置](https://hindsight.vectorize.io/developer/configuration)
2. 从 [2.0.0 正式源码 ZIP](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0) 的 `examples/modules/manage-memory/` 取出 `memory_server.py`、`hindsight_backend.py` 和 `requirements.txt`，放在同一个宿主服务目录。在此目录激活专用 Python 3.12 虚拟环境并运行 `python -m pip install -r requirements.txt`。网关固定使用 `hindsight-client==1.2.3`、`mcp==1.30.0` 和 `uvicorn==0.54.0`。独立网关安装包属于后续建设。
3. 在 Agent 可读工作区之外准备宿主绑定文件和回执路径。下例在 PowerShell 中使用 `C:/CoreMind-local/memory-host.json`。实际运行前把路径改成自己可写的本地目录，并预先创建目录。B 用户或其他分支应有独立凭据和各自的授权记忆库。

   ```json
   {
     "banks": {"demo-alice": {"kind": "personal"}},
     "readers": [{"tokenEnv": "COREMIND_MEMORY_AUTHORIZATION", "banks": ["demo-alice"]}],
     "administrators": [{"tokenEnv": "COREMIND_MEMORY_ADMIN_AUTHORIZATION", "banks": ["demo-alice"]}]
   }
   ```

4. 在服务终端注入两组不同的令牌。各令牌本体至少 24 个字符。如 Hindsight 服务要求 API key，另用 `COREMIND_HINDSIGHT_API_KEY` 注入。启动时保持服务终端运行。

   ```powershell
   $env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host '查询令牌' -MaskInput)
   $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION = 'Bearer ' + (Read-Host '宿主管理令牌' -MaskInput)
   python -B -X utf8 ./memory_server.py --hindsight-url http://127.0.0.1:8780 --config 'C:/CoreMind-local/memory-host.json' --state 'C:/CoreMind-local/memory-receipts.json' --port 8769
   ```

   网关监听 `127.0.0.1:8769`。绑定文件与回执位于业务工作区之外，每个回执文件只由一个运行的网关独占。

## 核对写入、召回、更正和遗忘

在单独的宿主管理终端注入管理令牌，保存一条已确认偏好。每次独立演示使用新的文档 ID。重试保留同一 ID、原版本、内容和来源。

```powershell
$env:COREMIND_MEMORY_ADMIN_AUTHORIZATION = 'Bearer ' + (Read-Host '宿主管理令牌' -MaskInput)
$memoryUrl = 'http://127.0.0.1:8769/admin'
$memoryHeaders = @{ Authorization = $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION }
$memory = @{
    bankId = 'demo-alice'
    documentId = 'summary-format-' + [guid]::NewGuid().ToString('N')
    expectedVersion = 0
    text = '资料摘要优先使用表格。'
    source = 'demo:host-confirmed-preference'
    occurredAt = [datetime]::UtcNow.ToString('yyyy-MM-dd')
    kind = 'fact'
}
$saveBody = $memory | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/retain" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $saveBody
```

预期返回 `active` 和版本 `1`。在新的业务目录和独立 Python 3.12 虚拟环境运行 `python -m pip install mcp==1.30.0`。将下面的客户端保存为 UTF-8 的 `read_memory.py`。

```python
import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async def main():
    headers = {"Authorization": os.environ["COREMIND_MEMORY_AUTHORIZATION"]}
    async with httpx.AsyncClient(headers=headers) as http:
        async with streamable_http_client("http://127.0.0.1:8769/mcp", http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                assert [t.name for t in (await session.list_tools()).tools] == ["recall_memory"]
                reply = await session.call_tool("recall_memory", {"query": sys.argv[1]})
                assert not reply.isError
                print(json.dumps(json.loads(reply.content[0].text), ensure_ascii=False))

asyncio.run(main())
```

业务终端只注入读令牌。运行查询，核对 `demo-alice`、文档 ID、版本 `1`、正文和来源。绑定到另一个空库的有效读者应得到空的 `memories`，无效凭据返回 HTTP 401。

```powershell
$env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host '查询令牌' -MaskInput)
python -X utf8 read_memory.py '资料摘要应该采用哪种格式？'
```

回到宿主管理终端，将刚写入的版本 1 更正为版本 2。

```powershell
$memory.expectedVersion = 1
$memory.text = '资料摘要优先使用清单。'
$memory.source = 'demo:host-confirmed-correction'
Invoke-RestMethod -Method Post -Uri "$memoryUrl/correct" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body ($memory | ConvertTo-Json -Compress)
```

在业务终端重复同一条查询，核对只返回版本 `2` 的清单偏好。

调用 `/admin/reflect` 时传入 `bankId` 和 `query`，核对输出引用的已确认记忆。反思响应需要宿主确认后才能另行写入。遗忘传入原记忆库和文档标识。

```powershell
$forgetBody = @{ bankId = $memory.bankId; documentId = $memory.documentId } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/forget" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $forgetBody
```

预期返回 `forgotten`。要清除同一记忆库中由 CoreMind 管理的所有文档，向 `/admin/forget-bank` 传入 `bankId`。重启服务后，从新会话检查已遗忘内容无法召回。恢复旧 Hindsight 备份前，保留最新宿主回执并重放相应遗忘请求，再开放服务。旧会话的数据保留和恢复属于其原数据域。

## CoreMind 四入口验收

业务项目接入见[配置指南](../../../docs/modules/manage-memory/GUIDE.zh-CN.md)。如需复现仓库内的四入口用例，在完整检出根目录执行 `npm ci`、`npm run build`，在验收环境执行 `python -m pip install -e ./python`。保持网关运行，在写入表格偏好后、更正或遗忘前运行 `node examples/modules/manage-memory/acceptance.mjs "资料摘要应该采用哪种格式？" "资料摘要优先使用表格。"`。驱动使用 8770 端口的确定性模型夹具、检出目录的 CLI 和源码 Worker，通过 `COREMIND_MEMORY_PYTHON` 选择解释器。验收独立安装时应改用公开 CLI、SDK 及 wheel 默认内置 Worker，真实模型效果单独复验。

返回[中文指南](../../../docs/modules/manage-memory/GUIDE.zh-CN.md)。逐项验收见[开发 SOP](../../../docs/modules/manage-memory/SOP.zh-CN.md)。
