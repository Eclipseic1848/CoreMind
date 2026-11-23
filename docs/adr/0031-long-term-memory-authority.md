# Hindsight 保存长期记忆，CoreMind 管理作用域和确认

## 状态

P2-B 已确认选择 Hindsight OSS，固定版本为 1.2.3。能力依据为《智能体构建能力图谱 V1.0.2》的 05.01 至 05.04。原图 SHA-256 为 `71ac4675ea99413c383095b60b32f68c1e67c53603258deff9048007ade4fdac`。[Issue #393](https://github.com/Eclipseic1848/CoreMind/issues/393) · [Hindsight v1.2.3](https://github.com/vectorize-io/hindsight/releases/tag/v1.2.3)

## 事实域与权限

- [ADR 0001](0001-fact-domains-and-projections.md) 中的现有事实域保留各自职责。Hindsight 的 `documentId` 标识一条可更正的记忆，一个文档可对应多个原子事实。来源用 `(sessionId, entryId)`、`runId` 或宿主事件 ID 关联，并记录发生时间和版本。
- 宿主把项目、主体、团队和分支绑定到独立 Memory Bank，再为会话显式授予可使用的库。分叉的记忆权限重新绑定。查找、确认、更正和遗忘都核对授权范围。Bank ID 用于组织数据，鉴权由 CoreMind 服务执行。[会话分支决策](0029-public-session-tree-navigation.md) · [Memory Banks](https://hindsight.vectorize.io/developer/api/memory-banks)
- Agent 只收到接受查询文本的 MCP 工具。宿主管理入口使用独立凭据发起确认写入、更正、遗忘和 Reflect。Hindsight 后端和管理凭据由宿主隔离。CoreMind 本地回执保存 ID、版本、状态和重试校验值，正文和向量存入 Hindsight。
- 已确认事实用 Retain `chunks` 写入，Recall 做语义召回并返回版本和来源。Reflect 仅在来源直接支持本次问题的关键事实时，返回含归因、适用条件、反例及待确认项的候选。证据不足或改答相近主题时不生成候选。宿主确认后才写入正式记忆。自动 Observations 默认关闭，启用前须验证作用域、来源和删除。[Retain](https://hindsight.vectorize.io/developer/retain) · [Recall](https://hindsight.vectorize.io/developer/api/recall) · [Reflect](https://hindsight.vectorize.io/developer/api/reflect)

## 写入、纠错与遗忘

| 操作 | 预期行为 |
| --- | --- |
| 写入与重试 | 确认前校验内容、来源和权限。以作用域与宿主事件 ID 去重。同一事件重复提交只返回原结果。同一事件 ID 对应不同内容时拒绝。 |
| 确认经验 | 有权宿主发起 Retain，原生请求成功后才使回执生效。待确认候选只返回宿主，正式召回按活动回执过滤。 |
| 更正 | 操作绑定当前版本，沿用同一 Hindsight 文档 ID 替换内容。请求失败时保持待决，暂停召回该文档。相同请求可重试并恢复活动状态。 |
| 到期与遗忘 | UTC 到期日 00:00 起停止召回。遗忘先阻断召回，再调用原生文档删除。成功后仅保留无正文的回执。验证主库、事实及观察的实际影响后才能宣称清除范围。 |
| 备份恢复 | 恢复旧备份前先用最新遗忘回执清理，再开放读服务。缺少有效回执时拒绝将旧备份接入服务。已外发的数据和历史会话中的副本由其原数据域管理。 |

现有 Runtime 会把工具结果持久化到会话。遗忘验收检验长期记忆库、其派生数据和新的独立会话。要清除旧会话消息、已发给模型的内容或备份介质中的历史副本，须定义各数据域自己的清理约定。[会话写入路径](../../packages/coremind-runtime/src/runtime.ts#L4655-L4683)

## 图谱推荐工程的使用位置

| 能力 | 本次采用 | 图谱中的其他推荐 |
| --- | --- | --- |
| 05.01 会话与长期记忆 | CoreMind Session 和运行状态承接会话与短期工作信息，Hindsight Memory Banks 支持个人、项目、团队的跨任务资源。 | [LangGraph](https://github.com/langchain-ai/langgraph) 和 [Letta Code](https://github.com/letta-ai/letta-code) 的分层和持续会话方式用于对照。 |
| 05.02 写入与召回 | Hindsight Retain、Recall 处理来源、时间和语义匹配；CoreMind 决定写入与当前任务可见范围。 | [Mem0](https://github.com/mem0ai/mem0)、[LangMem](https://github.com/langchain-ai/langmem) 和 [Graphiti](https://github.com/getzep/graphiti) 分别适合作为事实检索、定制提取、时态关系的对照。 |
| 05.03 经验提炼与反思 | Hindsight Reflect 整理成败过程、归因、条件与反例，宿主确认后沉淀。Observations 支持跨多条经验的持续归纳。 | LangMem 可用于提示改进对照。[Reflexion](https://github.com/noahshinn/reflexion) 用作反馈和反例的实验参照。 |
| 05.04 更新遗忘与纠错 | Hindsight 文档替换与删除，配合 CoreMind 的版本回执、期限和授权范围。 | 图谱建议的 Mem0、Graphiti 和 LangMem 提供各自的更正与删除语义。复杂时态关系先用独立数据验证 Graphiti，再决定扩展。 |

自托管使用 Hindsight 的 PostgreSQL 存储。本地试运行可用 Hindsight 自带的 pg0。原生文档删除会清除来源于该文档的记忆与观察，相关 LLM Trace、备份及早先 Session 副本分别验收。生成模型、嵌入和排序端点由宿主显式配置。[存储](https://hindsight.vectorize.io/developer/storage) · [文档生命周期](https://hindsight.vectorize.io/developer/api/documents) · [观察删除](https://hindsight.vectorize.io/developer/observations)

## 验收用例

固定业务中性样例。主体 A 确认「资料摘要优先用表格」，另建会话核对采用情况，之后更正为「优先用清单」并遗忘。验收在两个项目、两名主体、两个 Agent 和同一会话两个分支内覆盖以下情形。

| 用例 | 通过条件 |
| --- | --- |
| M01 重试、并发与冲突 | 同一事件重复或并发提交只产生一条记录。冲突请求被拒绝。重启后去重结果一致。 |
| M02 跨会话与跨范围 | A 明确授权共享后可在独立会话召回。其他主体、项目、Agent、未授权分支均读不到。按 ID 访问同样被拒，Agent 文件和命令工具无法绕过服务读取存储或管理凭据。 |
| M03 来源与误提炼 | 一次提问不进入有效记忆。从两个成败不同的 Run 构造带反例的候选，断言待确认、确认和撤回三种状态。错误提炼和错误采用分别计数。 |
| M04 更正、竞争与失败 | 新会话只采用「优先用清单」。旧版本直接召回为空。模拟 Hindsight 更新失败时暂停该记忆召回，同一请求成功重试后恢复。旧版本并发更正不得覆盖新版本。 |
| M05 到期、遗忘与恢复 | 到期立即停止召回。遗忘后查主存储、索引和读路径，重启及新会话均无旧值。重放旧写入仍被挡住，恢复旧备份后按遗忘回执清理。 |
| M06 入口、错误与断连 | CLI + YAML、TypeScript、Python 同步及异步均核对同一事实 ID、版本和范围。权限拒绝和服务不可用提供明确结果，无历史正文兜底。 |

## 实施顺序

1. 先建最小持久事实服务，按 M01、M02、M04、M05 验证写入、隔离、纠错及遗忘。
2. 接入候选提炼和确认流程，用固定夹具验证 M03，再用获准的模型和固定样例评估提炼与采用质量。
3. 复用知识模块的公开接入方式，验证 M06，并登记 `manage-memory` 实现、测试、双语指南、SOP、开发 Skill、可运行示例和 `module.yaml`。分别记录入口合同与真实模型效果。[现有知识示例](../../examples/modules/manage-knowledge/README.zh-CN.md)
