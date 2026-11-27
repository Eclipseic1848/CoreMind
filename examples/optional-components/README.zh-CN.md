# 按需部署与恢复 CoreMind 组件

业务项目可从 CoreMind 2.2.0 的 [Runtime 最小配置](../../docs/guide/06-capability-construction.md#从自己的项目开始)开始。只运行 Runtime 时省略 MCP 组件绑定，三项服务均可保持停止。为选中的组件建立独立的 Python 环境和业务目录，再把通过探针的地址与读令牌绑定给需要它的 Agent。

| 选择 | 固定组合与就绪检查 | 需要保留的数据 |
| --- | --- | --- |
| 知识 | 知识 wheel 0.1.1、BGE-M3 的固定 ONNX 权重与 Qdrant Client 1.15.1。验证带令牌的 `/health`，再实际搜索和回查一条许可引文。[部署与恢复](../modules/manage-knowledge/deployment/README.zh-CN.md) | 清单、原文、版本与撤回目录。内存索引从这些文件重建。 |
| Hindsight 记忆 | 网关 0.1.1、Hindsight 1.2.3、PostgreSQL 18.1。先检查数据库和 Hindsight `/health/ready`，再通过网关召回已确认事实。[部署与恢复](../modules/manage-memory/deployment/README.zh-CN.md) | 数据库逻辑备份、宿主绑定和最新回执。调用方仅持有自己的读令牌。 |
| 本体 | 本体 wheel 0.1.1、RDFLib 7.6.0、pySHACL 0.40.2。探测 `/health` 后查询业务对象并核对模型版本。[部署与恢复](../modules/manage-ontology/deployment/README.zh-CN.md) | 模型、实例、映射、约束和动作定义。启用写操作时另保留动作回执和权威业务记录。 |

示例使用宿主 Python 环境和上游 PostgreSQL 工具，三个组件默认监听回环地址的 `8767`、`8769`、`8879` 端口。Hindsight 的模型端点和权重由部署方选择，宿主负责界定哪些信息可发给该端点。合成验收使用本地确定性模型和预置权重。[Hindsight 自托管安装](https://hindsight.vectorize.io/developer/installation)

1. **仅 Runtime。** 运行最小项目并检查工具目录和调用数。无绑定时保持三项服务停止。
2. **按需启用。** 按对应示例启动服务并运行探针。先在项目中接入一项，核对原文、事实来源或模型版本，再接入需要的组合。读用法只给相应读令牌。
3. **停用与恢复。** 先解除项目中的工具与服务绑定，再停止专属进程并保留数据。按各组件 SOP 暂停写入并备份，在空目录或新数据库验收恢复后再开放业务流量。保留最新遗忘回执，遇到未知动作依据权威业务记录核对。切换应用版本用相容的数据和已经验证的环境。记录启动与恢复时间和备份大小。

## 从仓库外复跑

在仓库外准备两个空白 npm 项目和一个独立 Python 3.12 环境。固定安装 npm 的 `coremind-ai@2.2.0`、`coremind-cli@2.2.0` 和 Python 的 `coremind-ai==2.2.0`。从源码根目录运行验收，参数使用绝对路径。首次保持三个组件停止，验证无服务配置时的 Runtime、Skill 与本地工具。

```sh
node scripts/verify-optional-consumer.mjs "<仓库外 npm 项目>" "<Python 解释器>"
```

分别部署组件后，把 [services.example.json](services.example.json) 复制到私有目录，填入各自的回环端点、读令牌、输入与预期结果。先由宿主按记忆部署示例写入合成事实。使用另一个空白 npm 项目验收组件单用、组合及全部移除。

```sh
node scripts/verify-optional-consumer.mjs "<另一个 npm 项目>" "<Python 解释器>" "<私有服务配置 JSON>"
```

脚本以本地确定性模型驱动 CLI、TypeScript、Python 同步和异步入口，把工具目录、调用和结果写入 `optional-acceptance.json`。备份与恢复的独立验收见组件示例。
