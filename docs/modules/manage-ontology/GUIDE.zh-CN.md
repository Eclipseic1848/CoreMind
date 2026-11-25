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

将 2.0.0 源码解压在服务目录，设置 `COREMIND_SRC` 为其绝对路径。在业务项目中准备自己的五份模型文件，设置 `MODEL_DIR` 为其目录。首次演练可指向源码中的 `examples/modules/manage-ontology/models/document-review`。使用专用 Python 3.12 环境，按下段设置读取凭据后启动。源码示例锁定 RDFLib 7.6.0、pySHACL 0.40.2、MCP 1.30.0 和 Uvicorn 0.54.0，用于加载本地 Turtle 并执行 SHACL Core 校验。[依赖清单](../../../examples/modules/manage-ontology/requirements.txt) · [RDFLib](https://pypi.org/project/rdflib/7.6.0/) · [pySHACL](https://pypi.org/project/pyshacl/0.40.2/)

```sh
python -m pip install -r "$COREMIND_SRC/examples/modules/manage-ontology/requirements.txt"
python -B -X utf8 "$COREMIND_SRC/examples/modules/manage-ontology/ontology_server.py" --model-dir "$MODEL_DIR" --port 8879
```

通过宿主环境提供 `COREMIND_ONTOLOGY_AUTHORIZATION`，其值为含 `Bearer ` 前缀的完整头，令牌部分至少 24 个无空白字符。按 Agent 显式绑定 `ontology_describe`、`ontology_validate_record` 和 `ontology_inspect_action`，可分别查询资源、校验来源记录、检查动作。返回结果中的 `modelVersion`、`modelDigest` 和 `bundleDigest` 用于复核具体模型与资产。`coremind-off.yaml` 展示停用形式。[只读配置](../../../examples/modules/manage-ontology/coremind.yaml) · [无本体配置](../../../examples/modules/manage-ontology/coremind-off.yaml)

使用支持 Streamable HTTP 的 MCP 客户端连接 `http://127.0.0.1:8879/mcp`，按设置发送 `Authorization`。使用资料模型时调用 `ontology_describe`，传入 `{"resource":"urn:doc:guide"}`，核对对象及模型版本。CoreMind 项目从只读配置取 `mcp.servers.ontology` 和所需的 Agent 工具声明即可，保留自己的模型提供商。只接入本体时无需运行知识服务或 Hindsight。

## 绑定可写动作

`publish` 把目标资料从 `reviewed` 转为 `published`。检查结果 `ready` 表示具备候选资格。需要执行时，宿主单独启用 `--enable-actions`，提供不同的 `COREMIND_ONTOLOGY_ACTION_AUTHORIZATION`，再将 `ontology_perform_action` 按有副作用的工具绑定到获准调用者。CoreMind 工具政策决定是否准入；处理器执行前重新核对当前图、目标和预期状态，随后按业务回执判断是否完成。

示例处理器生成合成回执。接入业务系统时须核对请求标识、对象、前态和实际状态。回执缺失或结果不符会留下 `unknown`；此时先查询业务系统，不得重放写操作。示例在当前宿主进程内记录请求，跨重启的对账与持久回执由业务宿主提供。[宿主实现](../../../examples/modules/manage-ontology/ontology_project.py) · [验收步骤](SOP.zh-CN.md)

## 升级与移除

升级前保存五份模型文件、版本及摘要。若启用了业务动作，先停写并保留宿主持久回执与待核对请求。在独立进程中用相同模型复查对象、违规样例和动作前置条件，再切换端点。需要回滚时恢复旧服务与模型，逐笔核对已实际发生的业务动作。停用某项目时移除其本体工具、服务绑定及凭据。独占服务可停机并移除专用环境，共享服务只解除该项目绑定。业务模型、映射和动作回执由项目方保管。
