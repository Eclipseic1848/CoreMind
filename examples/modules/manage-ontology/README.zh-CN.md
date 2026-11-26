# 可选本体示例

空白业务项目可只安装 `coremind-ontology-mcp` 0.1.0 并发起 MCP 查询。下面的独立验收与四入口源码示例分别运行。资料助手是额外的组合用例。[本体接入指南](../../../docs/modules/manage-ontology/GUIDE.zh-CN.md)

资料整理助手使用 [`document-review`](models/document-review/actions.json) 模型查询资料、验证复核人以及检查可否发布。完全相同的适配器也能加载 [`equipment-maintenance`](models/equipment-maintenance/actions.json)，查询设备、维护站点及复修动作。

从仓库外的业务目录启动只读服务、检查 `/health` 与对象查询，然后演练 SQLite 两库备份、隔离恢复和运行环境切回，见[最小部署与恢复](deployment/README.zh-CN.md)。

## 从 wheel 验收

把本目录的 `installed_acceptance.py`、`receipt_handler.py` 和 `models/` 复制到仓库外。在新建并激活的 Python 3.12 虚拟环境中运行下面的命令。`business-test` 需要为空，执行后将保留业务资产和两份数据库。

```sh
python -m pip install coremind-ontology-mcp==0.1.0
python -I -B -X utf8 installed_acceptance.py --project ./business-test
python -m pip uninstall -y coremind-ontology-mcp
```

需要从源码验收时，按[组件说明](../../../components/ontology/README.md)构建并安装 0.1.0 wheel，再执行同一验收脚本。

验收使用真实的 Streamable HTTP 客户端、pySHACL 和本机 SQLite 业务事务。它启动只读与写服务、切换模型版本、模拟业务写入后进程中断并核对重放行为。成功时返回 `businessReceipts: 2`、`unknownReplayBlocked: true` 和 `modelRollback: "1.0.0"`。卸载后业务目录应保留 `business.sqlite3`、`action-receipts.sqlite3` 和模型文件。

## 验收动作回执对账

按[组件说明](../../../components/ontology/README.md)构建当前源码的 wheel，在独立 Python 3.12 环境中安装。沿用上面的仓库外示例文件，使用新的空目录保存两份 SQLite 数据库。公开的 0.1.0 wheel 使用上一节的原命令。

```sh
python -I -B -X utf8 installed_acceptance.py --project ./business-reconcile --reconcile
```

脚本配置独立宿主对账令牌，模拟业务已提交但网关在返回回执前中断。重启后先验证不匹配的证据仍会阻断新动作，再读取本地权威业务回执并写回。原请求 ID 经 MCP 回读终态，对象查询反映业务后态。成功回执的 `reconciledStatuses` 包含 `completed` 和 `failed`，`reconcileExecutorCalls` 为 `0`，后续动作及重启复查后的状态为 `published`。

下列请求体来自示例业务账本中已提交的复核动作。使用自己项目的模型时，按[宿主对账指南](../../../docs/modules/manage-ontology/GUIDE.zh-CN.md#宿主对账与后续动作)提交已核实的实际结果。

```json
{
  "requestId": "lost",
  "resource": "urn:doc:draft",
  "previousState": "draft",
  "status": "completed",
  "state": "reviewed"
}
```

## 运行

准备 Python 3.12、uv 与项目要求的 Node.js。从仓库根目录执行以下命令。Windows 的解释器路径如下，Linux 使用 `.scratch/ontology-venv/bin/python`。

```powershell
uv venv --python 3.12 .scratch/ontology-venv
$env:COREMIND_ONTOLOGY_PYTHON = (Resolve-Path '.scratch/ontology-venv/Scripts/python.exe').Path
uv pip install --python $env:COREMIND_ONTOLOGY_PYTHON -r examples/modules/manage-ontology/requirements.txt
npm run build
& $env:COREMIND_ONTOLOGY_PYTHON -B -X utf8 -m unittest discover -s examples/modules/manage-ontology -p 'test_ontology_*.py' -v
node examples/modules/manage-ontology/acceptance.mjs
```

验收启动独立回环端口的真实 MCP 服务和确定性模型夹具。覆盖 CLI/YAML、TypeScript、Python 同步和异步。启用路径返回本体和映射版本、违规位置与动作候选，停用仍可整理资料，模型无法加载时返回 `unavailable`。写入用例额外验证两种令牌、Runtime 批准和业务前置条件始终生效。[启用示例配置](coremind.yaml) · [停用示例配置](coremind-off.yaml)

## 跨会话资料整理

```powershell
uv pip install --python $env:COREMIND_ONTOLOGY_PYTHON -r examples/modules/manage-ontology/requirements.txt -r examples/modules/manage-knowledge/requirements.txt
node examples/modules/manage-ontology/composition.mjs
```

第一个会话对照资料版本、附引用并保存摘要。宿主确认表格偏好后，第二个会话在另一份资料上复用偏好和 Skill，本体拦住草稿发布。更正偏好并撤回资料后，第三个会话读取清单偏好与有效引用。脚本运行真实 MCP、资料与记忆服务适配器、Skill、本体和文件工具，知识索引、记忆存储与模型使用确定性夹具。

将业务模型、数据、形状、映射和动作文件换成经审核的本地资产，即可将同一 MCP 入口接到自己的项目。动作示例仅用于合成数据。正式业务处理器以事务、请求 ID 和真实系统回执提供持久结果。[接入指南](../../../docs/modules/manage-ontology/GUIDE.zh-CN.md)

使用两个独立项目、真实 Qdrant、Hindsight 和业务方提供的模型验收资料整理助手，见[真实服务组合验收](LIVE-COMPOSITION.zh-CN.md)。
