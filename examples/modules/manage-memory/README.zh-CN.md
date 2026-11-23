# 让资料整理助手记住已确认的偏好

本例用 Hindsight 1.2.3 保存「资料摘要优先用表格」这类已经确认的记忆。宿主负责授权、确认、更正和遗忘。CoreMind Agent 只能通过 `recall_memory(query)` 查询当前可见的记忆。

## 准备服务

1. 启动 Hindsight 1.2.3，将 API 绑定到本地 `127.0.0.1:8780`。Python 3.12 可安装 `hindsight-api-slim[embedded-db,local-onnx]==1.2.3`，用 `hindsight-api --host 127.0.0.1 --port 8780` 启动。设 `HINDSIGHT_API_DATABASE_URL=pg0://coremind-memory-demo` 以隔离演示数据库。由宿主配置模型，中文召回使用适配中文的嵌入模型。设 `HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks`、`HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false`、`HINDSIGHT_API_LLM_TRACE_ENABLED=false` 和 `HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT=true`。不配置神经重排时使用 `HINDSIGHT_API_RERANKER_PROVIDER=rrf`。本地模型或代理绑定回环地址时，将 `127.0.0.1,localhost` 加入 `NO_PROXY`。[安装与部署](https://hindsight.vectorize.io/developer/installation) · [模型配置](https://hindsight.vectorize.io/developer/configuration)
2. 在仓库根目录用专用 Python 环境安装 `python -m pip install -r examples/modules/manage-memory/requirements.txt`。执行 `npm run build` 构建 CLI、TypeScript 和 Python Worker，并在用于验收的 Python 环境执行 `python -m pip install -e ./python`。
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
   python -B -X utf8 examples/modules/manage-memory/memory_server.py --hindsight-url http://127.0.0.1:8780 --config 'C:/CoreMind-local/memory-host.json' --state 'C:/CoreMind-local/memory-receipts.json'
   ```

   CoreMind 的读写服务监听 `127.0.0.1:8769`。[示例配置](coremind.yaml)只授予 Agent 查询工具。

## 核对写入、召回、更正和遗忘

在第二个 PowerShell 终端注入同一对演示令牌，保存一条已确认偏好。每次独立演示请用新的记忆 ID。重试时保留同一文档 ID、原版本、内容和来源。

```powershell
$env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host '查询令牌' -MaskInput)
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

预期返回 `active` 和版本 `1`。执行四入口检查，脚本会在 `127.0.0.1:8770` 启动并关闭本地模型夹具。若 `python` 默认不是已安装 `coremind-ai` 的解释器，请设置 `COREMIND_MEMORY_PYTHON` 为其绝对路径。

```powershell
node examples/modules/manage-memory/acceptance.mjs '资料摘要应该采用哪种格式？' '资料摘要优先使用表格。'
```

四个入口应返回相同的记忆库、文档标识、版本、正文和来源。改用另一个主体或未经授权分支查询，预期无命中。

更正前先核对当前版本。下例将刚写入的版本 1 更正为 2，再执行同一四入口检查。

```powershell
$memory.expectedVersion = 1
$memory.text = '资料摘要优先使用清单。'
$memory.source = 'demo:host-confirmed-correction'
Invoke-RestMethod -Method Post -Uri "$memoryUrl/correct" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body ($memory | ConvertTo-Json -Compress)
node examples/modules/manage-memory/acceptance.mjs '资料摘要应该采用哪种格式？' '资料摘要优先使用清单。'
```

调用 `/admin/reflect` 时传入 `bankId` 和 `query`，核对输出引用的已确认记忆。反思响应需要宿主确认后才能另行写入。遗忘传入原记忆库和文档标识。

```powershell
$forgetBody = @{ bankId = $memory.bankId; documentId = $memory.documentId } | ConvertTo-Json -Compress
Invoke-RestMethod -Method Post -Uri "$memoryUrl/forget" -Headers $memoryHeaders -ContentType 'application/json; charset=utf-8' -Body $forgetBody
```

预期返回 `forgotten`。要清除同一记忆库中由 CoreMind 管理的所有文档，向 `/admin/forget-bank` 传入 `bankId`。重启服务后，从新会话检查已遗忘内容无法召回。恢复旧 Hindsight 备份前，保留最新宿主回执并重放相应遗忘请求，再开放服务。旧会话的数据保留和恢复属于其原数据域。

真实模型效果和 Hindsight 原生观察清理需单独实测。接口验收使用的模型夹具只验证运行入口和 memory 工具的交互。

返回[中文指南](../../../docs/modules/manage-memory/GUIDE.zh-CN.md)。逐项验收见[开发 SOP](../../../docs/modules/manage-memory/SOP.zh-CN.md)。
