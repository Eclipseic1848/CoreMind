# 接入业务本体

## 准备业务模型

先写下业务问题，例如「这份资料由谁复核，现在能否发布」。选一个能执行的实例和一个应当被阻止的实例，确定每个对象的稳定标识。示例把完整模型放在[资料复核目录](../../../examples/modules/manage-ontology/models/document-review/)。

| 项目文件 | 业务方填写 |
| --- | --- |
| `model.ttl` | 类型、父类、属性和关系定义。示例用 `urn:review:Document` 表示资料，用 `reviewedBy` 指向复核人。 |
| `data.ttl` | 带稳定 IRI 的初始实例、属性和实例间的关系。 |
| `mapping.json` | 映射版本、来源、源标识、确认的对象或待确认候选、别名、编码及单位换算。 |
| `shapes.ttl` | SHACL Core 约束，例如资料必须有一名已登记的复核人，重量按非负十进制千克计。 |
| `actions.json` | 模型版本、动作目标类、状态属性、允许的前态和预期后态。 |

例如，`catalog.A1` 与 `archive.ARCH-1` 都确认指向 `urn:doc:guide`；`catalog.A2` 有两个候选，返回 `needs_confirmation`。输入字段「克重」取值 1250 时按 0.001 换算为 1.25 千克，保留原始值和映射版本。字段名称相同或形状校验合规都无法代替业务方确认映射。建模与校验参考 [Turtle](https://www.w3.org/TR/turtle/) 和 [W3C SHACL](https://www.w3.org/TR/shacl/)。

## 从空白项目只启用本体

在业务主机的独立 Python 3.10+ 环境从 PyPI 安装服务。将五份业务模型文件放在环境外，设置 `MODEL_DIR` 为其绝对路径，向服务进程提供 `COREMIND_ONTOLOGY_AUTHORIZATION`。凭据为完整的 `Bearer <token>`，令牌至少 24 个无空白字符。

```sh
python -m pip install coremind-ontology-mcp==0.1.0
coremind-ontology-mcp --version
coremind-ontology-mcp --model-dir "$MODEL_DIR" --port 8879
```

也可从源码根目录用 `python -m pip wheel --no-deps --wheel-dir .scratch/ontology-wheels ./components/ontology` 构建 wheel，或安装团队分发的同版本 wheel。

首个只读项目只需要自己的模型和该组件。示例模型、服务配置及可保留回执的仓库外测试见[验收示例](../../../examples/modules/manage-ontology/README.zh-CN.md)。

可按 Agent 选择 `ontology_describe`、`ontology_validate_record` 和 `ontology_inspect_action`，分别查询对象、校验记录和检查动作前置条件。用 `modelVersion`、`modelDigest`、`bundleDigest` 核实本次资产。参照[只读配置](../../../examples/modules/manage-ontology/coremind.yaml)，停用对照见[无本体配置](../../../examples/modules/manage-ontology/coremind-off.yaml)。

使用支持 Streamable HTTP 的 MCP 客户端连接 `http://127.0.0.1:8879/mcp`，按设置发送 `Authorization`。使用资料模型时调用 `ontology_describe`，传入 `{"resource":"urn:doc:guide"}`，核对对象及模型版本。CoreMind 项目从只读配置取 `mcp.servers.ontology` 和所需的 Agent 工具声明即可，保留自己的模型提供商。只接入本体时无需运行知识服务或 Hindsight。

## 绑定可写动作

在只读模式下调用 `ontology_perform_action` 会收到 `action_not_authorized`。要开放写操作，业务方为获准的 Agent 绑定该工具并保留 CoreMind 的审批策略。服务端设置与读取凭据不同的 `COREMIND_ONTOLOGY_ACTION_AUTHORIZATION`，启动时追加 `--action-handler /abs/handler.py --receipt-db /abs/state/receipts.sqlite3`。只加载经宿主审阅的本地处理器；该 Python 文件导出同步 `execute(command)`。目录需已存在且可写。

处理器按 `requestId` 在业务系统执行事务，返回 `requestId`、`resource`、`previousState`、`status`、`state`。[业务事务示例](../../../examples/modules/manage-ontology/receipt_handler.py)演示条件更新和业务回执在同一 SQLite 事务提交。组件另在派发前写入本项目独占的回执库。已确认的请求可回读；崩溃、丢失或不一致的回执保留为 `unknown`，重启后继续阻断同一对象的新动作。查询业务权威记录后由负责人对账，保留未决库。

## 升级与移除

升级前保存五份模型文件、版本及摘要。若启用了业务动作，先停写并保留宿主持久回执与待核对请求。在独立进程中用相同模型复查对象、违规样例和动作前置条件，再切换端点。需要回滚时恢复旧服务与模型，逐笔核对已实际发生的业务动作。停用某项目时移除其本体工具、服务绑定及凭据。独占服务可停机并移除专用环境，共享服务只解除该项目绑定。业务模型、映射和动作回执由项目方保管。

停止独占进程后，使用 `python -m pip uninstall coremind-ontology-mcp` 卸除。备份或回退时保留同一份最新回执库；用旧库覆盖它会丢失新请求的证据。历史 2.0.0 源码示例只在进程内保存动作状态，回切到该示例时只开放读取。新模型初始状态与已确认回执不一致时，组件拒绝该对象动作并返回 `model_state_conflict`。
