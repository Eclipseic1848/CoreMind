# 独立部署与恢复 Hindsight 记忆

这套单机示例使用 PostgreSQL 18.1、pgvector 0.8.5、Hindsight API 1.2.3 和 CoreMind 记忆网关 0.1.0。网关通过回环地址提供 Streamable HTTP MCP。业务项目只需要网关地址和读令牌。数据库、宿主回执和绑定文件由部署方管理。

## 启动顺序与持久目录

准备 Python 3.12、带 pgvector 的 PostgreSQL 二进制，并将其命令目录加入 PATH。从本目录将依赖清单和绑定样例复制到一个仓库外的宿主目录，用独立虚拟环境安装固定版本。PowerShell 7 命令如下。

```powershell
python -m pip install -r requirements.txt
Copy-Item bindings.example.json bindings.json
New-Item -ItemType Directory -Path state,backup
coremind-memory-mcp --version
postgres --version
```

在新宿主目录初始化专用 PostgreSQL。初始化时输入专用密码，随后通过 PostgreSQL 的密码文件或已配置的私有连接环境供客户端使用。保存 `state/pgdata`。已有演示实例时复用此目录并跳过初始化。

```powershell
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '55434'
$env:PGUSER = 'hindsight'
initdb -D state/pgdata -U hindsight -A scram-sha-256 -W --encoding=UTF8 --no-locale
pg_ctl -D state/pgdata -l state/postgres.log -o '-h 127.0.0.1 -p 55434' -w start
pg_isready -d postgres
createdb -T template0 memory_demo
psql -X -v ON_ERROR_STOP=1 -d memory_demo -c 'CREATE EXTENSION vector;'
```

在 Hindsight 终端中，将 `HINDSIGHT_API_DATABASE_URL` 设为指向该数据库的 PostgreSQL URI，由宿主私下注入凭据。以下示例只写入已确认的文本块，使用本地 ONNX 嵌入。准备[固定 BGE-M3 模型](../../../../components/knowledge/README.md)的两个文件，将 `tokenizer.json` 复制到 `assets/hindsight-tokenizer/`，在同目录保存 UTF-8 的 `config.json`，内容为 `{"model_type":"xlm-roberta"}`。

```powershell
$env:HF_HUB_OFFLINE = '1'
$env:TRANSFORMERS_OFFLINE = '1'
$env:HINDSIGHT_API_LLM_PROVIDER = 'none'
$env:HINDSIGHT_API_EMBEDDINGS_PROVIDER = 'onnx'
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_MODEL_PATH = (Resolve-Path './assets/model_quantized.onnx').Path
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_TOKENIZER_NAME_OR_PATH = (Resolve-Path './assets/hindsight-tokenizer').Path
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_OUTPUT_NAME = 'dense_vecs'
$env:HINDSIGHT_API_EMBEDDINGS_ONNX_DIMENSIONS = '1024'
$env:HINDSIGHT_API_RERANKER_PROVIDER = 'rrf'
$env:HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION = 'false'
$env:HINDSIGHT_API_RETAIN_EXTRACTION_MODE = 'chunks'
hindsight-api --host 127.0.0.1 --port 8780
```

确认 Hindsight 的 `/health/ready` 返回成功，再在另一终端启动网关。为绑定文件引用的三个变量注入彼此不同的完整 Bearer 令牌，实际令牌部分至少 24 个字符。业务项目只持其读令牌。

```powershell
$env:NO_PROXY = '127.0.0.1,localhost'
Invoke-RestMethod 'http://127.0.0.1:8780/health/ready'
coremind-memory-mcp --hindsight-url http://127.0.0.1:8780 --config bindings.json --state state/receipts.json --port 8769
```

由宿主调用管理接口写入一条合成事实，然后用[空白 Python 客户端](../README.zh-CN.md#从空白-python-项目直接召回)直接召回。使用另一个已授权读者查询同一问题，应得到空记忆列表。用 `pg_isready` 验证数据库，用 `/health/ready` 验证 Hindsight，再验证网关认证、工具发现和真实召回。网关 `/health` 只说明网关进程就绪。

```powershell
$hostHeaders = @{ Authorization = $env:COREMIND_MEMORY_ADMIN_AUTHORIZATION }
$record = @{ bankId='subject-a'; documentId='summary'; expectedVersion=0; text='资料摘要应采用两列表格，分别写结论和证据。'; source='fixture:confirmed'; occurredAt='2026-01-01'; kind='fact' }
Invoke-RestMethod 'http://127.0.0.1:8769/admin/retain' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($record | ConvertTo-Json -Compress)
$control = $record.Clone()
$control.documentId = 'control'
$control.text = '专题档案仅提供只读副本。'
Invoke-RestMethod 'http://127.0.0.1:8769/admin/retain' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($control | ConvertTo-Json -Compress)
```

## 备份、恢复与独立回退

1. 暂停业务写入并停止单写者网关。用 PostgreSQL 官方工具导出逻辑备份，再复制同一时点的回执及绑定。为每套备份选新目录并限制访问权限。凭据单独保管。

   ```powershell
   pg_dump --format=custom --no-owner --no-privileges -f backup/memory.dump -d memory_demo
   Copy-Item state/receipts.json backup/receipts-at-backup.json
   Copy-Item bindings.json backup/bindings.json
   ```

2. 演练时在源库重启网关，用管理接口遗忘合成文档 summary 后停止网关。恢复前另行保全**当前最近的回执**。在具有同版 pgvector 的 PostgreSQL 创建全新的空数据库，原库继续作为独立回退点。

   ```powershell
   $forgotten = @{ bankId='subject-a'; documentId='summary' }
   Invoke-RestMethod 'http://127.0.0.1:8769/admin/forget' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($forgotten | ConvertTo-Json -Compress)
   ```

   停止源网关后复制最新回执，再恢复数据库。

   ```powershell
   Copy-Item state/receipts.json backup/receipts-latest.json
   createdb -T template0 memory_demo_restored
   pg_restore --exit-on-error --single-transaction --no-owner --no-privileges -d memory_demo_restored backup/memory.dump
   ```

3. 将 Hindsight 改接恢复库，在隔离端点启动。用最近回执的工作副本启动网关，依次检查正向召回、隔离和旧记录遮蔽。核对最近回执中为 `forgetting` 和 `forgotten` 的文档，用各记忆库认可的管理令牌对恢复端点逐条重放 `POST /admin/forget`。例如在恢复用网关绑定 8771 后重放上面的合成文档。

   ```powershell
   $forgotten = @{ bankId='subject-a'; documentId='summary' }
   Invoke-RestMethod 'http://127.0.0.1:8771/admin/forget' -Method Post -Headers $hostHeaders -ContentType 'application/json; charset=utf-8' -Body ($forgotten | ConvertTo-Json -Compress)
   ```

   旧数据库快照可能含已经遗忘的原生记录。以原生文档和派生记忆均已消失、对照事实仍可召回作为恢复验收。备份后其他新增或更正事项按宿主业务记录对账，处理完毕再开放读取。若需回退网关版本，在专用环境切换版本并带上最近的绑定和回执，核对上述结果。停用时先从业务项目移除绑定，再依次停止网关、Hindsight 和 PostgreSQL，保留授权保管的目录与备份。

   当前源码构建启用经验依据追踪后，回退到不支持追踪的版本时沿用最新回执，给旧网关配置 `administrators: []`。旧网关在回退窗口仅提供读取，遗忘重放和复核由支持追踪的网关完成。[复核与回退步骤](../../../../docs/modules/manage-memory/SOP.zh-CN.md#验收经验追溯与复核)

   ```powershell
   pg_ctl -D state/pgdata -m fast -w stop
   ```

## 自动演练

从仓库根目录运行。脚本自建回环 PostgreSQL、真实 Hindsight 和网关，使用合成事实，退出时关停本次服务。若有已验签的 [2.0.0 源码包](https://github.com/Eclipseic1848/CoreMind/releases/tag/v2.0.0)，可追加 `--previous-source` 与该包的 `examples/modules/manage-memory` 绝对路径，演练 0.1.0 回退旧入口及重新升级。

```powershell
python -X utf8 examples/modules/manage-memory/deployment/acceptance.py --pg-bin '<PostgreSQL bin>' --model-dir '<固定模型目录>' --work-dir '<尚不存在的演练目录>'
```

安装当前源码构建的候选 wheel 后，在同一命令加 `--experience-review`。演练在备份前确认一条引用两份依据的经验，遗忘一份依据后检查待复核状态，再恢复旧数据库并沿用最新回执。追加 `--previous-source` 可验证旧网关只读期间经验继续隐藏。回到候选网关后，由宿主用仍有效的依据更正经验，再核对新版本和复核清单。

输出包含版本、备份大小与摘要、实际启动和恢复耗时，以及逐项验证结果。Windows 原生演练覆盖真实服务和逻辑恢复。Linux 工程 CI 使用独立网关的生命周期单测和既有组合检查，原生 PostgreSQL 逻辑恢复在目标 Linux 宿主上可按同一脚本验收。[Hindsight 自托管](https://hindsight.vectorize.io/1.2/developer/installation) · [PostgreSQL 备份恢复](https://www.postgresql.org/docs/18/backup-dump.html)
