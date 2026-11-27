# 从空白项目接入 Hindsight 记忆

宿主运行 Hindsight 和 MCP 网关；业务项目持读令牌召回已确认事实。下面从两个独立目录启动服务和标准 MCP 客户端。

固定 PostgreSQL 的部署、备份和回退步骤见[独立部署与恢复示例](deployment/README.zh-CN.md)。

## 准备服务

1. 启动 Hindsight 1.2.3，将 API 绑定到本地 `127.0.0.1:8780`。Python 3.12 可安装 `hindsight-api-slim[embedded-db,local-onnx]==1.2.3`，用 `hindsight-api --host 127.0.0.1 --port 8780` 启动。设 `HINDSIGHT_API_DATABASE_URL=pg0://coremind-memory-demo` 以隔离演示数据库。由宿主配置模型，中文召回使用适配中文的嵌入模型。设 `HINDSIGHT_API_RETAIN_EXTRACTION_MODE=chunks`、`HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION=false`、`HINDSIGHT_API_LLM_TRACE_ENABLED=false` 和 `HINDSIGHT_API_LLM_TRACE_DELETE_WITH_DOCUMENT=true`。不配置神经重排时使用 `HINDSIGHT_API_RERANKER_PROVIDER=rrf`。本地模型或代理绑定回环地址时，将 `127.0.0.1,localhost` 加入 `NO_PROXY`。[安装与部署](https://hindsight.vectorize.io/developer/installation) · [模型配置](https://hindsight.vectorize.io/developer/configuration)
2. 在宿主的专用 Python 3.12 环境运行 `python -m pip install coremind-memory-mcp==0.1.1`。需要从源码安装时，可在仓库根目录运行 `python -m pip wheel --no-deps ./components/memory --wheel-dir dist`，将 wheel 交付宿主后在文件所在目录运行 `python -m pip install ./coremind_memory_mcp-0.1.1-py3-none-any.whl`。执行 `coremind-memory-mcp --version` 核对版本。兼容基线为 Hindsight API/客户端 1.2.3，已验证的 PostgreSQL 版本为 18.1。早期脚本保留于 [2.0.0 源码附件](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0)。
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
   coremind-memory-mcp --hindsight-url http://127.0.0.1:8780 --config 'C:/CoreMind-local/memory-host.json' --state 'C:/CoreMind-local/memory-receipts.json' --port 8769
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

预期返回 `active` 和版本 `1`。

### 从空白 Python 项目直接召回

将 [direct-project](direct-project/requirements.txt) 目录复制到仓库外的空白业务项目，准备独立 Python 3.12 环境，在该目录运行 `python -m pip install -r requirements.txt`。只用直调时，安装 `mcp==1.30.0` 即可。

业务终端以 `COREMIND_MEMORY_AUTHORIZATION` 提供完整读令牌。宿主管理凭据保留在宿主侧。示例使用回环地址，`COREMIND_MEMORY_MCP_URL` 默认是 `http://127.0.0.1:8769/mcp`，端口可按实际服务调整。运行 Agent 时，用 `COREMIND_MODEL_BASE_URL`、`COREMIND_MODEL_NAME` 和 `COREMIND_MODEL_API_KEY` 配置应用自己的 OpenAI 兼容模型。

```powershell
$env:COREMIND_MEMORY_AUTHORIZATION = 'Bearer ' + (Read-Host '查询令牌' -MaskInput)
python -X utf8 app.py direct '资料摘要应该采用哪种格式？'
python -X utf8 app.py agent '资料摘要应该采用哪种格式？'
```

直接模式输出 `memories`，核对 `demo-alice`、文档 ID、版本 `1`、正文和来源。Agent 的工具结果应包含同一条已确认偏好。使用无效凭据复查 HTTP 401。绑定到另一个空库的有效读者应得到空的 `memories`。完成下方更正和遗忘复查后，停止专用网关，确认直接召回退出非零。运行下列命令验证移除记忆绑定后仍能运行 Agent，`toolCalls` 应为 `0`。

```powershell
python -X utf8 app.py runtime-only '请只回答 OK'
```

### 更正与遗忘

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

## 经验依据与复核

按上文从当前源码构建网关后，在同库先保留两条已确认事实。宿主审核候选并调用 `POST /admin/retain`，在原写入字段上加 `kind: "experience"` 和 `evidence`。下面的 ID 与版本取自两份实际写入回执。`source` 仍保存便于人查找的引用。

```json
{
  "kind": "experience",
  "evidence": [
    { "documentId": "meeting-note", "version": 1 },
    { "documentId": "review-result", "version": 1 }
  ]
}
```

使用 `POST /admin/correct` 更正第一条依据。宿主调用 `POST /admin/review-status`，请求体为 `{"bankId":"demo-alice"}`。返回的 `pendingReview` 应含经验 ID、当前版本和原依据，此时读者召回不应含该经验。核对新依据后，用 `/admin/correct` 将经验当前版本填入 `expectedVersion`，提交更新后的整组 `evidence`。再检查新版本及其依据均能召回。第二条依据遗忘后，复查经验再次转待复核。

在仓库根目录用已安装[示例依赖](requirements.txt)的 Python 执行自动验收。它经过实际宿主管理和 MCP 入口，使用本地 Hindsight 夹具。

```sh
python -B -X utf8 examples/modules/manage-memory/review_evaluation.py
```

命令向标准输出写入 JSON 回执。用 `--output` 可另存到已有目录。回退验收加 `--legacy-archive` 并传入已核验的 2.0.0 正式源码 ZIP，验证旧网关基于最新回执以只读模式运行。

## CoreMind 四入口验收

在新的业务目录按[配置指南](../../../docs/modules/manage-memory/GUIDE.zh-CN.md)安装相同版本的 2.2.0 CLI、TypeScript SDK 与 Python SDK。复制本目录的 `acceptance.mjs`、`coremind.yaml`、`search.mjs` 和 `search.py`，将 YAML 的 `mcp.servers.memory.url` 指向测试网关；验收配置保留回环模型端口 8770。业务终端仅注入读令牌，用 `COREMIND_MEMORY_PYTHON` 指定已安装 SDK 的解释器。宿主写入表格偏好后、更正或遗忘前，在业务目录执行 `node acceptance.mjs "资料摘要应该采用哪种格式？" "资料摘要优先使用表格。"`。驱动加载已安装的 CLI、SDK 和 wheel 内置 Worker，核对四入口召回的是同一条事实。运行入口使用确定性模型夹具，真实模型效果另行验证。

如要复验已安装的独立 wheel，将 [check_component.py](check_component.py) 复制到空白目录。准备两个隔离测试库、各自的读令牌和首库的管理员令牌。在宿主验收终端注入 `COREMIND_MEMORY_AUTHORIZATION`、`COREMIND_MEMORY_OTHER_AUTHORIZATION`、`COREMIND_MEMORY_ADMIN_AUTHORIZATION`，运行 `python -I -X utf8 check_component.py --bank demo-alice --url http://127.0.0.1:8769`。脚本经宿主 HTTP 和独立 MCP 会话验证幂等写入、不同主体、更正、到期与遗忘，使用新的文档 ID 并在退出时遗忘测试文档。

## 离线效果回归

在仓库根目录使用已安装示例依赖的 Python 环境执行。

```sh
python -B -X utf8 examples/modules/manage-memory/effect_evaluation.py
```

命令读取[五题合成集](effect-cases.json)，向标准输出写入一条 JSON 回执。回执保留候选、确认前召回、最终召回与采用来源和版本。失败时退出码非零。Hindsight 响应和采用规则均固定，可在没有 Hindsight 进程或模型凭据时运行。

返回[中文指南](../../../docs/modules/manage-memory/GUIDE.zh-CN.md)。逐项验收见[开发 SOP](../../../docs/modules/manage-memory/SOP.zh-CN.md)。
