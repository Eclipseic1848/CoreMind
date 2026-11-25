# 可选本体示例

资料整理助手使用 [`document-review`](models/document-review/actions.json) 模型查询资料、验证复核人以及检查可否发布。完全相同的适配器也能加载 [`equipment-maintenance`](models/equipment-maintenance/actions.json)，查询设备、维护站点及复修动作。

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
