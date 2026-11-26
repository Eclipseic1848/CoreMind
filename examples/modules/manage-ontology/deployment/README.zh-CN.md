# 本体的最小部署与恢复

本例只运行本体 MCP 服务。用 Python 3.12 的独立环境安装发布版 `coremind-ontology-mcp==0.1.0`，随 wheel 固定 RDFLib 7.6.0、pySHACL 0.40.2、MCP 1.30.0 和 Uvicorn 0.54.0。[公开制品](https://pypi.org/project/coremind-ontology-mcp/0.1.0/)

| 路径 | 所属与用途 |
| --- | --- |
| `model/` | 业务方的 Turtle、SHACL、映射和动作定义。 |
| `service/`、`replacement/` | 可分别重建的服务环境，升级时先保留原环境。 |
| `state/action-receipts.sqlite3` | 启用动作时，组件保存已完成和未决请求的独占回执库。 |
| `state/business.sqlite3` | 本例合成 SQLite 业务事务及其权威回执。生产业务系统的备份由业务方提供。 |

## 启动只读服务

以下命令使用 uv，从仓库根目录运行。为另一个终端记录 `$example` 与 `$project` 的实际路径。Linux 命令见本页末尾。

```powershell
$example = (Resolve-Path 'examples/modules/manage-ontology').Path
$project = Join-Path ([IO.Path]::GetTempPath()) ('cm-ontology-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $project | Out-Null
Copy-Item -LiteralPath (Join-Path $example 'models/document-review') -Destination (Join-Path $project 'model') -Recurse
uv venv --python 3.12 (Join-Path $project 'service')
uv pip install --python (Join-Path $project 'service/Scripts/python.exe') coremind-ontology-mcp==0.1.0
& (Join-Path $project 'service/Scripts/coremind-ontology-mcp.exe') --version
```

通过宿主的凭据管理方式分别向服务终端和读取终端注入相同的 `COREMIND_ONTOLOGY_AUTHORIZATION`，含 `Bearer ` 前缀和至少 24 个无空白字符。服务终端前台启动。

```powershell
& (Join-Path $project 'service/Scripts/coremind-ontology-mcp.exe') --model-dir (Join-Path $project 'model') --port 8879
```

从读取终端运行下列命令。它先检查经授权的 `/health` 返回 `ready`，再通过 Streamable HTTP MCP 查询 `urn:doc:guide`，输出对象、模型版本和摘要。健康就绪和已知对象读取都通过后再开放使用。关闭服务用其前台终端的 `Ctrl+C`。

```powershell
& (Join-Path $project 'service/Scripts/python.exe') -I -B -X utf8 (Join-Path $example 'deployment/probe.py')
```

## 备份、隔离恢复与回退

1. 记录当前 wheel、五份模型文件及摘要。启用动作时另设独立的动作令牌和经审核的处理器，组件与业务分别保存回执。暂停业务写入并停止旧进程，再为模型、处理器、组件回执及业务库取同一停止点的备份。凭据通过宿主重新注入。
2. 将备份恢复到新业务目录。合成示例使用 Python 的 [SQLite backup 接口](https://docs.python.org/3/library/sqlite3.html#sqlite3.Connection.backup) 保存两份数据库，并检查 `PRAGMA quick_check`。启动隔离服务，确认模型摘要、已知对象和业务回执。已完成请求只读回已存回执，未知请求继续阻断同一对象的新 ID。
3. 切换程序或业务模型前，在隔离目录复跑相同查询和回执用例。程序回退时用原环境重新打开相同的最新回执。旧业务备份用于隔离复核，生产动作结果以当前权威业务系统为准。遇到 `unknown` 继续冻结相关对象，核对权威业务回执后由负责人处理。

以下命令自动创建合成数据、暂停服务、备份和恢复，使用另一环境启动恢复副本，再切回第一环境复验。`$project/recovery-case` 必须为空。脚本还通过原生命周期用例完成模型 `1.0.0 → 1.1.0 → 1.0.0` 回退。两套应用环境均用 0.1.0，演练同版重建和切回。验收输出两次启动耗时、备份字节数、两份业务回执、零额外处理器调用和未知请求阻断结果。

```powershell
uv venv --python 3.12 (Join-Path $project 'replacement')
uv pip install --python (Join-Path $project 'replacement/Scripts/python.exe') coremind-ontology-mcp==0.1.0
& (Join-Path $project 'service/Scripts/python.exe') -I -B -X utf8 (Join-Path $example 'deployment/restore_acceptance.py') --project (Join-Path $project 'recovery-case') --replacement-console (Join-Path $project 'replacement/Scripts/coremind-ontology-mcp.exe')
```

验收目录保留 `original/`、`backup/` 和 `restored/`。核对两个 SQLite 文件而后移除不再使用的组件绑定，撤销相应令牌，按业务保留规则留存模型和回执。[开发 SOP](../../../../docs/modules/manage-ontology/SOP.zh-CN.md)

## Linux 命令

从仓库根目录准备环境。按前面的凭据步骤，在服务终端启动前台进程，在读取终端设置相同变量后运行探针。完成读取并停止服务后再跑恢复演练。

```sh
ontology_example="$PWD/examples/modules/manage-ontology"
ontology_project="$(mktemp -d)"
cp -R "$ontology_example/models/document-review" "$ontology_project/model"
uv venv --python 3.12 "$ontology_project/service"
uv pip install --python "$ontology_project/service/bin/python" coremind-ontology-mcp==0.1.0
```

```sh
"$ontology_project/service/bin/coremind-ontology-mcp" --model-dir "$ontology_project/model" --port 8879
```

```sh
"$ontology_project/service/bin/python" -I -B -X utf8 "$ontology_example/deployment/probe.py"
uv venv --python 3.12 "$ontology_project/replacement"
uv pip install --python "$ontology_project/replacement/bin/python" coremind-ontology-mcp==0.1.0
"$ontology_project/service/bin/python" -I -B -X utf8 "$ontology_example/deployment/restore_acceptance.py" --project "$ontology_project/recovery-case" --replacement-console "$ontology_project/replacement/bin/coremind-ontology-mcp"
```
