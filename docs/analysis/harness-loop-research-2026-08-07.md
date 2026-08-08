# CoreMind Harness / Loop Engineering 调研与 Claude Code 对标

> 调研日期：2026-08-07
> CoreMind 快照：本地提交 `7ff19a9dfec9372931d391b925fb920208f90cc3`，工作区在调研开始时干净
> 资料边界：只采用官方文档、官方工程博客、官方仓库 README/源码和规范；本文不以 GitHub stars、下载量或二手榜单证明“主流”
> 标记：**事实** = 可由本地源码或一手资料直接核验；**推断** = 基于事实的架构判断；**建议** = 尚未实施的选择

## 一、结论先行

### 1.1 是否已经达到 Claude Code 水平

**结论：目前不能声称 CoreMind 已达到 Claude Code 水平。**

更精确地说：

- **事实**：CoreMind 已具备一个成立的配置驱动 agent 框架骨架：自主工具循环、9 个内置工具/脚本工具、静态多 Agent 工作流、步骤上限/深度上限/超时/条件重试、会话续接、非破坏式压缩、统一事件流、CLI/库入口、技能注入和运行质量摘要。
- **推断**：这些能力大致覆盖了“基础 agent loop + 一部分应用层工作流”，但尚未覆盖成熟生产 harness 的关键闭环：工具权限与人工审批、执行隔离、可持久化的运行态/中断恢复、幂等副作用、MCP 与按需工具发现、生命周期 hooks/middleware、动态委派与任务状态、文件级 checkpoint/rewind、完整 trace、系统化 eval。
- **事实**：Claude Code 当前官方能力不仅是“循环调用工具”，还包括独立上下文 subagents、实验性 agent teams、自动上下文压缩、CLAUDE.md 与 auto memory、allow/ask/deny 权限、OS 级文件系统/网络 sandbox、hooks、MCP、skills/plugins、会话 resume/fork、文件 checkpoint/rewind、OpenTelemetry、Agent SDK 与非交互自动化。参见 [Claude Code 扩展能力总览](https://code.claude.com/docs/en/features-overview)（访问：2026-08-07）、[Agent SDK loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)（访问：2026-08-07）。
- **事实**：本次没有运行 CoreMind 与 Claude Code 的同模型、同任务、同工具、同预算 A/B 评测；因此本文能给出的是**能力与架构差距判断**，不是性能等价证明。

一句话定位：**CoreMind 已达到“可用的初级配置驱动 agent framework alpha”，尚未达到“Claude Code 级生产 harness”，更未达到 Claude Code 的完整 coding product 体验。**

### 1.2 不应该把“Claude Code 水平”理解成单一刻度

本文用四层分析模型澄清范围；这不是行业标准，只是本次对标工具：

| 层级 | 含义 | CoreMind 当前判断 | Claude Code 当前判断 |
|---|---|---|---|
| L0 模型接入 | 多模型 API、流式输出、结构化工具调用 | 已有 | 已有 |
| L1 Agent loop | 模型决策 → 工具执行 → 环境反馈 → 再决策；有停止护栏 | 已有 | 已有且更完整 |
| L2 Production harness | 权限、隔离、持久化运行态、HITL、可观测、评测、恢复、扩展协议 | 部分 | 大部分已有 |
| L3 Coding product | 终端/IDE/Web/CI、代码导航、任务管理、并行 agent、工作树、撤销、生态与企业治理 | 早期 CLI/TUI | 成熟产品面 |

CoreMind 的产品定位是“面向新手/初级开发者的配置驱动智能体开发框架”，并不需要复制 Claude Code 的全部 L3 功能。更合理的目标是：

> 先达到 **CoreMind Harness Grade**：新手用 YAML 创建的 agent 能够安全运行、可暂停/恢复、不会重复副作用、出了问题能定位、升级前能用 eval 回归；再按需要增加一个 Claude Code 风格的可选 coding profile。

## 二、口径与证据边界

### 2.1 Workflow、Agent、Harness、Eval harness

- **事实**：Anthropic 将 workflow 定义为“LLM 与工具沿预定义代码路径编排”，将 agent 定义为“LLM 动态决定自己的过程和工具使用”；并建议先采用最简单可行方案，只在确有收益时增加复杂度。[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（访问：2026-08-07）。
- **事实**：Anthropic 将 agent harness/scaffold 定义为让模型能够作为 agent 行动的系统：处理输入、编排工具调用并返回结果；evaluation harness 则负责批量运行任务、记录轨迹、评分和汇总。评测“一个 agent”实际是在共同评测模型与 harness。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)（访问：2026-08-07）。
- **推断**：CoreMind 同时包含两类东西：CoreMind Loop 提供动态 agent loop；CoreMind YAML workflow 提供预定义流程。两者都合理，但必须在配置和文档中清楚区分，不能把静态 `prompt/call/parallel/if/switch` 自动称作“自主规划”。

### 2.2 本地判断基线

本次直接检查了以下本地实现：

- 配置与工作流 schema：[`packages/coremind-config/src/schema/config.ts`](../../packages/coremind-config/src/schema/config.ts)、[`workflow.ts`](../../packages/coremind-config/src/schema/workflow.ts)
- Agent 构建：[`packages/coremind-runtime/src/agent-factory.ts`](../../packages/coremind-runtime/src/agent-factory.ts)
- 运行时与会话：[`runtime.ts`](../../packages/coremind-runtime/src/runtime.ts)、[`session.ts`](../../packages/coremind-runtime/src/session.ts)、[`chat-session.ts`](../../packages/coremind-runtime/src/chat-session.ts)
- 编排与护栏：[`orchestrator.ts`](../../packages/coremind-runtime/src/orchestrator.ts)
- 事件与质量：[`events.ts`](../../packages/coremind-runtime/src/events.ts)、[`quality.ts`](../../packages/coremind-runtime/src/quality.ts)
- 工具与技能：[`packages/coremind-tools/src/registry.ts`](../../packages/coremind-tools/src/registry.ts)、[`packages/coremind-templates/src/skills.ts`](../../packages/coremind-templates/src/skills.ts)

`handoff.md` 报告当前基线为 117 过 / 2 跳、biome 与 typecheck 通过；**本调研子任务没有重新运行测试**，因此该数字只作为交接记录，不作为本报告新产生的验证证据。

## 三、CoreMind 当前真实能力

| 能力 | 当前实现证据 | 判断 |
|---|---|---|
| 配置驱动 | TypeBox + YAML/JSON；未知字段告警；provider/agents/tools/workflow/session | **优势成立**：对新手的入口清晰 |
| 自主工具循环 | `buildAgent()` 使用锁定的底层智能体运行库，工具结果回到模型；工具执行配置为 parallel | **L1 已有** |
| 工具 | read/ls/find/grep/bash/edit/write/web-fetch/web-search + JS 脚本工具 | **基础 coding/action 面可用**，但无权限信封 |
| 静态工作流 | prompt/call/parallel/if/switch，支持嵌套与变量传递 | **适合新手**；不是动态规划器 |
| 运行护栏 | 深度默认 8、总步骤默认 100、单步默认 5 分钟、AbortSignal、条件重试 | **已有基础停止与重试护栏** |
| 多 Agent | 配置中定义多个 Agent；每步骤创建独立 Agent；通过输出变量传递 | **静态协作已有**；无动态 spawn、共享任务表或 peer messaging |
| 会话 | JSONL、按 `sessionId` 续接、只追加本轮消息、路径穿越校验 | **对话续接已有** |
| 压缩 | 上游 `shouldCompact/prepareCompaction/compact`；压缩条目生成上下文视图，原存储不改 | **方向正确**；仍缺更完整的上下文策略/记忆层 |
| 技能 | 3 个内置技能 + 配置目录自定义 `README.md`；全文拼接到 system prompt | **可用但粗粒度**；不是按需/渐进加载 |
| 事件 | 统一 `agent_start/text_delta/tool_call/tool_result/step_start/step_end/agent_end/error` | **良好基座**；事件字段不足以完整重放、审计和关联 trace |
| 质量摘要 | 步骤、工具失败、耗时、token、输出字符数 | **运行统计，不是质量评测** |
| SDK/CLI | 库门面、run/chat、JSON events、TUI、abort | **嵌入和自动化入口已有** |

本地源码范围搜索没有发现 CoreMind 自己实现的 permission、approval、sandbox、hook/middleware、MCP、checkpoint/rewind、OpenTelemetry/trace 或 eval runner。这里的“没有发现”专指当时的 CoreMind 包装层；不能把上游运行库的可选扩展能力自动算成 CoreMind 已交付能力。

## 四、Claude Code 当前可验证的 Harness / Loop 能力

### 4.1 自主循环、工具与停止条件

- **事实**：Claude Agent SDK 的 loop 是：接收 prompt → 模型判断 → 执行一个或多个工具 → 将结果反馈给模型 → 重复，直到模型返回无工具调用的最终答案。结果包含最终文本、token、费用和 session ID；可用 `maxTurns` 与预算限制控制循环。[How the agent loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)（访问：2026-08-07）。
- **事实**：Claude Code 提供文件读取/搜索/编辑、Shell、Web、Agent、Skill、任务跟踪等内置工具；权限规则、subagent 工具白名单和 hook matcher 都引用同一工具名。[Tools reference](https://code.claude.com/docs/en/tools-reference)（访问：2026-08-07）。
- **推断**：CoreMind 已有相同的最小循环形状，但缺少统一的 turn/budget/result 状态模型。当前 `RunQuality` 是结束后的汇总，不能代替循环过程中的预算决策。

### 4.2 规划、任务与多 Agent

- **事实**：Claude Code subagent 从独立上下文开始，可限制工具/权限，可前台阻塞或后台并发，完成后向主会话返回摘要；官方明确提醒多个 subagent 会增加 token，并建议只在上下文隔离或自包含任务时使用。[Create custom subagents](https://code.claude.com/docs/en/sub-agents)（访问：2026-08-07）。
- **事实**：Agent teams 由 lead、独立上下文 teammates、共享任务列表和点对点消息构成；官方标为实验性，并明确指出 token 成本和文件冲突风险。[Orchestrate teams](https://code.claude.com/docs/en/agent-teams)（访问：2026-08-07）。
- **事实**：Agent SDK 提供 todo tracking；CLI 也有 plan/permission 模式，但“模型在内部进行了思考”不等于存在可恢复、可审计的任务计划。[Todo Lists](https://code.claude.com/docs/en/agent-sdk/todo-tracking)（访问：2026-08-07）、[Configure permissions](https://code.claude.com/docs/en/permissions)（访问：2026-08-07）。
- **推断**：CoreMind 的 `call/parallel` 是静态拓扑，不等价于 Claude Code 的动态 delegation。若用户目标是通用业务 agent，动态 subagent 应作为可选能力，不应强制所有 YAML 进入复杂多 Agent 模式。

### 4.3 上下文、会话与记忆

- **事实**：Claude Code 会先清理旧工具输出，再自动压缩会话；`/compact` 可显式控制摘要重点。project-root CLAUDE.md、auto memory 和已调用 skills 在压缩后有各自的重注入规则。[Context window](https://code.claude.com/docs/en/context-window)（访问：2026-08-07）、[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)（访问：2026-08-07）。
- **事实**：Claude Code 将“用户/组织写的持久指令”和“Claude 自动积累的项目记忆”分开；auto memory 按仓库保存并在会话启动加载，CLAUDE.md 支持组织、用户、项目、局部和按路径规则。[How Claude remembers your project](https://code.claude.com/docs/en/memory)（访问：2026-08-07）。
- **事实**：官方 context engineering 建议把 context 当作有限且边际收益递减的资源，优先保留最小高信号集合；通过文件路径、查询和工具按需发现上下文，而不是一次性灌入所有资料。长任务常用 compaction、结构化笔记和多 Agent 三类手段。[Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)（访问：2026-08-07）。
- **推断**：CoreMind 的“全文 skills 拼接 + 会话压缩”解决了部分长度问题，但尚未形成 `instructions / working state / conversation / long-term memory / skill resources` 的分层模型。

### 4.4 权限、人工审批与 sandbox

- **事实**：Claude Code 权限与 sandbox 是互补层：权限控制工具、文件与域是否可尝试；sandbox 用 OS 级机制限制 Bash 及其子进程的文件系统和网络访问。[Configure permissions](https://code.claude.com/docs/en/permissions)（访问：2026-08-07）。
- **事实**：sandbox 同时强调文件系统隔离和网络隔离；只有其中一层不足以阻止敏感文件外泄或绕过边界。[Configure sandboxed Bash](https://code.claude.com/docs/en/sandboxing)（访问：2026-08-07）、[Anthropic sandbox engineering](https://www.anthropic.com/engineering/claude-code-sandboxing)（访问：2026-08-07）。
- **事实**：Claude Agent SDK 可把审批和澄清作为 loop 内输入处理，并可用 declarative rules/hooks 修改、允许或拒绝工具调用。[Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)（访问：2026-08-07）、[Handle approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)（访问：2026-08-07）。
- **推断**：CoreMind 当前最严重的产品级差距是：`bash/edit/write/web-*` 没有 CoreMind 层的统一 allow/ask/deny 策略、作用域和可恢复审批事件。对新手产品而言，这比增加更多 workflow 类型更优先。

### 4.5 Hooks、MCP、Skills 与 Plugins

- **事实**：Claude Code hooks 覆盖 session、prompt、tool、permission、subagent、task、compaction 等生命周期；部分事件可阻断或改写调用，还支持 command/HTTP/MCP tool/prompt/agent hook。[Hooks reference](https://code.claude.com/docs/en/hooks)（访问：2026-08-07）。
- **事实**：Claude Code MCP 支持本地 stdio 与远程 HTTP、OAuth、资源、动态能力刷新、重连和输出上限；Tool Search 默认延迟加载 MCP 工具定义，减少大量工具对 context 的占用。[Connect via MCP](https://code.claude.com/docs/en/mcp)（访问：2026-08-07）。
- **事实**：Skills 是可复用指令/知识/工作流；plugins 是打包 skills、hooks、subagents 和 MCP 的分发层。[Extend Claude Code](https://code.claude.com/docs/en/features-overview)（访问：2026-08-07）、[Skills](https://code.claude.com/docs/en/skills)（访问：2026-08-07）。
- **推断**：CoreMind 已有“技能内容”概念，但缺少标准 `SKILL.md` 元数据、渐进披露、资源/脚本、安全信任、命名空间和包级分发；也缺少所有工具共同经过的 extension/middleware seam。

### 4.6 Checkpoint、恢复与回退

- **事实**：Claude Code 每个用户 prompt 创建 checkpoint，可分别恢复代码、会话或两者；checkpoint 跨 resume 会话存在，但只跟踪直接编辑工具造成的文件变化，不跟踪 Bash 或外部进程修改，也不替代 Git。[Checkpointing](https://code.claude.com/docs/en/checkpointing)（访问：2026-08-07）。
- **事实**：Agent SDK session 保存 prompt、工具调用、工具结果和回复，并支持 continue/resume/fork；session 保存的是对话，不是文件系统。[Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)（访问：2026-08-07）。
- **推断**：CoreMind 的 JSONL 会话能续接对话，但还没有“workflow 在第 N 步崩溃后从最后成功边界继续”“审批等待数小时后继续”“副作用只执行一次”“文件变更撤销”这些 durable harness 语义。

### 4.7 可观测性、SDK、自动化与评测

- **事实**：Claude Code 可导出 OpenTelemetry metrics/events/traces，覆盖模型请求、工具执行、hooks、权限决定、MCP 连接、token/费用等；敏感内容默认不进入详细 telemetry，开启明文细节需要显式配置。[Monitoring](https://code.claude.com/docs/en/monitoring-usage)（访问：2026-08-07）。
- **事实**：Claude Agent SDK 把 Claude Code 的 loop、工具、权限、sessions、subagents、MCP、hooks 和 structured output 暴露给 TypeScript/Python；CLI print mode/JSON/streaming 和 CI 集成用于自动化。[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)（访问：2026-08-07）、[Run programmatically](https://code.claude.com/docs/en/headless)（访问：2026-08-07）。
- **事实**：Anthropic 官方 eval 方法要求区分 task、trial、grader、transcript/trajectory 和 outcome，并建议组合代码、模型和人工 grader；因为模型有随机性，关键任务需要多次 trial。[Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)（访问：2026-08-07）。
- **信息缺口**：截至访问日，Claude Code 官方文档索引没有把通用 agent eval runner 列为 Claude Code 内置用户功能；Anthropic提供的是评测方法、SDK 和案例。因此不能把“Claude Code 有 telemetry”误写成“Claude Code 已内置完整业务 eval 平台”。

## 五、代表性 Harness / Loop 工程实践

下列项目是本次按用户指定范围选取的官方参考，不代表市场份额排名。

### 5.1 Anthropic：从简单组合到长周期 generator/evaluator

1. **事实**：推荐从简单、可组合模式开始：prompt chaining、routing、parallelization、orchestrator-workers、evaluator-optimizer；只有开放式任务才使用自主 agent。[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)（访问：2026-08-07）。
2. **事实**：agent 每一步都应从环境获得 ground truth，可在 checkpoint/blocker 请求人类判断，并设置最大迭代等停止条件。
3. **事实**：长周期应用开发中，仅 compaction 不足；结构化 feature list、增量一次做一个功能、Git/进度文件交接、启动时先验证基本功能、端到端测试都显著重要。[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（访问：2026-08-07）。
4. **事实**：2026 年的后续实践把 planner、generator、独立 evaluator 分开；每个 sprint 先协商可测试的 done contract，任一质量维度未过阈值就反馈重做；同时强调每个 harness 组件都是对模型能力的假设，应随模型升级逐项消融。[Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps)（访问：2026-08-07）。

**对 CoreMind 的含义**：`retry.if` 只是最小 evaluator-optimizer 雏形。若没有明确 outcome、独立评价者、重试预算和副作用保护，不能把“自动重试”扩展成无限自修复循环。

### 5.2 OpenAI Agents SDK：显式 Runner、RunState、guardrails 与 tracing

- **事实**：Runner 循环在 final output、handoff 和 tool calls 之间转移；默认 `maxTurns=10`，支持 AbortSignal、session、输入过滤、工具并发上限、sandbox、错误处理和 server-side continuation。[Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)（访问：2026-08-07）。
- **事实**：multi-agent 主要区分两种拓扑：manager 把 specialists 当工具并保留控制，或 handoff 把会话控制权交给 specialist。[Agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)（访问：2026-08-07）。
- **事实**：工具审批会让 run 返回 interruptions；应用可序列化 `RunState`，长时间后重建 agent graph 并继续。审批覆盖嵌套 agent-as-tool。[Human in the loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)（访问：2026-08-07）。
- **事实**：guardrails 分 agent input/output 与 tool input/output，边界不同；官方特别说明哪些 hosted/built-in 工具不经过普通 function-tool guardrail pipeline。[Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)（访问：2026-08-07）。
- **事实**：SDK 内置 tracing，记录 LLM、工具、handoff、guardrail 与自定义事件；session 可持久化历史并支持 compaction。[Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)（访问：2026-08-07）、[Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)（访问：2026-08-07）。
- **事实**：当前 JS SDK 还提供 beta Sandbox Agents，将 workspace manifest、sandbox session/snapshot、filesystem/shell/skills/memory/compaction 与外层 Runner 的审批、tracing、handoff、resume 分开。[Sandbox Agents](https://openai.github.io/openai-agents-js/guides/sandbox-agents/)（访问：2026-08-07）。

**可复用原则**：把“对话 Session”“可序列化 RunState”“执行环境状态”拆开；把人工审批设计为 typed interruption，而不是 CLI 里的同步 `confirm()`。

### 5.3 LangGraph：显式状态图、checkpoint 与错误分类

- **事实**：LangGraph 在每一步保存 graph state checkpoint，支持 HITL、conversation memory、time travel、fork 和故障恢复；并区分 thread-scoped checkpointer 与 cross-thread store。[Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)（访问：2026-08-07）。
- **事实**：`interrupt()` 保存状态并可无限等待外部输入；恢复会从 node 开头重跑，因此 interrupt 前的副作用必须可重放/幂等，不能误以为是函数调用栈原地继续。[Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)（访问：2026-08-07）。
- **事实**：官方工程指南建议 state 保存 raw data、prompt 按需格式化；瞬态错误自动 retry，LLM 可修复错误写入 state 后回环，用户可修复错误 interrupt，未知错误向上抛；不同失败模式应拆成不同 node。[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)（访问：2026-08-07）。
- **事实**：graph API 原生支持 retry policy、并行、条件、map-reduce、loop 和 recursion limit。[Graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api)（访问：2026-08-07）。

**可复用原则**：持久化边界与节点粒度共同决定恢复成本；CoreMind 需要的不是更多 YAML 语法，而是把每一步变成可识别、可重试、可恢复、可审计的状态迁移。

### 5.4 Google ADK：确定性 workflow、Session/State/Memory 与 trajectory eval

- **事实**：ADK template workflow 明确区分 Sequential、Parallel、Loop，编排由预定义逻辑控制而非每次询问模型；较新的 graph/dynamic/collaborative workflow 能力依语言与版本而异。[Template workflows](https://adk.dev/agents/workflow-agents/)（访问：2026-08-07）、[Workflows](https://adk.dev/workflows/)（访问：2026-08-07）。
- **事实**：ADK 分开 `Session`（当前线程事件）、`State`（当前交互数据）和 `Memory`（跨会话可搜索信息），并通过服务接口替换内存、数据库或云后端。[Sessions and Memory](https://adk.dev/sessions/)（访问：2026-08-07）。
- **事实**：state 通过事件 delta 更新；直接绕开 SessionService 修改持久对象可能丢失跟踪与并发语义。[State](https://adk.dev/sessions/state/)（访问：2026-08-07）。
- **事实**：ADK eval 能检查工具 trajectory、中间响应和 final response，并允许自定义指标/阈值。[Evaluation criteria](https://adk.dev/evaluate/criteria/)（访问：2026-08-07）、[Custom metrics](https://adk.dev/evaluate/custom_metrics/)（访问：2026-08-07）。
- **事实**：ADK Agent Config 提供 YAML 形态，但官方标为 experimental，且有模型、语言和工具支持限制。[Agent Config](https://adk.dev/agents/config/)（访问：2026-08-07）。

**可复用原则**：CoreMind 的 YAML 是差异化优势，但配置驱动不应等于隐藏运行语义；schema 应能显式表达状态作用域、审批、恢复、终止和评测。

### 5.5 Microsoft Agent Framework 与 AutoGen：Harness、Workflow、Middleware 分层

- **事实**：Microsoft Agent Framework 把能力分成 Agents、带 batteries 的 Harness、以及 graph-based Workflows；Harness 包含计划/todo、compaction、文件与 memory、可记忆审批和 observability，Workflows 提供类型化路由、checkpoint 和 HITL。[Microsoft Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/)（访问：2026-08-07）。
- **事实**：框架提供 agent run、function call、chat client 三层 middleware，用于日志、guardrails、限流、异常和 telemetry，而不侵入 agent 业务逻辑。[Middleware](https://learn.microsoft.com/en-us/agent-framework/journey/adding-middleware)（访问：2026-08-07）。
- **事实**：workflow 有统一事件流和 OpenTelemetry 观测，官方事件包含 workflow/executor/superstep/request 等阶段。[Workflow events](https://learn.microsoft.com/en-us/agent-framework/workflows/events)（访问：2026-08-07）、[Workflow observability](https://learn.microsoft.com/en-us/agent-framework/workflows/observability)（访问：2026-08-07）。
- **事实**：Agent Skills 使用 advertise → load → resource → script 的渐进披露，并明确建议：低风险/幂等、由 AI 自主决定的任务适合 skill；涉及副作用、checkpoint、审批的业务过程适合 workflow。[Agent Skills](https://learn.microsoft.com/en-us/agent-framework/agents/skills)（访问：2026-08-07）。
- **事实**：AutoGen 官方仓库已标为 maintenance mode，并建议新项目使用 Microsoft Agent Framework。[AutoGen repository](https://github.com/microsoft/autogen)（访问：2026-08-07）。

**可复用原则**：不要再以 AutoGen 旧式 group chat 作为 CoreMind 新架构的主目标；更值得借鉴的是 middleware seam、Harness/Workflow 分层和渐进 skills。

### 5.6 底层运行库：极简 loop 与可选 coding harness

- **事实**：底层运行库按模型适配、智能体核心和 coding harness 分层；核心层提供工具调用和 state，coding 层提供交互式 harness。该结论来自 2026-08-07 的上游依赖审计。
- **事实**：上游主循环处理 assistant/tool result、steering 和 follow-up queues，并通过事件流暴露 turn/message/tool 生命周期。
- **事实**：上游 coding SDK 的会话对象管理 lifecycle、message history、model state、compaction、event streaming；运行时对象管理 session 替换、恢复和 fork。
- **事实**：上游 session 是 JSONL tree，可 branch/fork/clone；compaction 只改变提交给模型的视图，完整历史保留。
- **事实**：上游 skills 遵循 Agent Skills 结构并按描述 advertise、按需读取完整 `SKILL.md`；coding 扩展示例还提供 permission gates、sandbox、subagents、MCP 和 Git checkpoint 等能力，但这些不是仅依赖核心层就自动获得。

**可复用原则**：CoreMind 当前“不 fork、只依赖上游核心”的决策仍合理；但若目标升级为 Claude Code 风格 coding harness，应优先评估一个隔离的 coding adapter/profile，而不是在 CoreMind Runtime 内重新手写其 session/resource/extension 全栈。

## 六、跨框架收敛出的工程原则

### 原则 1：先选控制模型，再选 API

- 可预定义、需要审计的业务过程用 deterministic workflow。
- 子任务无法预知、需要环境探索时用 agent loop。
- 只在动态分解有可测收益时增加 orchestrator-workers；多 Agent 不是默认质量开关。

### 原则 2：事件日志是事实，模型 context 是可丢弃视图

- 原始输入、工具调用、工具结果、审批、状态迁移和副作用凭证进入 append-only run log。
- 发送给模型的 messages、摘要、近期尾部、skill/resource 是从日志派生的 view。
- compaction 不应删除审计历史；memory 也不应和当前 thread transcript 混为一层。

### 原则 3：Conversation Session、Workflow RunState、Execution Environment 必须分开

- Session 回答“之前聊了什么”。
- RunState 回答“流程执行到哪一步、为何暂停、哪些 side effects 已完成”。
- Execution Environment 回答“文件/容器/工作区当前是什么状态”。
- 只有三者都有稳定标识和版本，才能在进程重启或跨机器后正确恢复。

### 原则 4：checkpoint 必须和幂等设计一起出现

- 在外部副作用前记录 intent/idempotency key，在成功后记录 receipt。
- 恢复时先查 receipt，再决定跳过、补偿或重试。
- `interrupt()`/审批恢复往往从节点入口重跑；所有 interrupt 之前的动作必须纯函数或幂等。

### 原则 5：错误按“谁能修”分类

| 错误 | 处理者 | 建议动作 |
|---|---|---|
| 网络/限流等瞬态错误 | 系统 | 有上限指数退避，保留同一幂等键 |
| 工具参数/可解释执行错误 | 模型 | 作为结构化 tool error 返回 loop，允许改参 |
| 缺少业务信息/高风险授权 | 用户 | typed interrupt，持久化等待并恢复 |
| 断言/质量未达标 | evaluator | 带证据反馈 generator，限制轮数 |
| 未知程序错误 | 开发者 | fail fast + trace，不静默吞掉 |

### 原则 6：停止条件应是多维预算

至少同时支持 turns/steps、wall time、token、费用、tool failures、replans/retries 和用户取消；到达上限时返回结构化 `stopped_reason`，不能只抛一个不可恢复异常。

### 原则 7：工具是 Agent-Computer Interface，不是普通函数清单

- 工具目的和边界必须互斥、命名空间清晰、参数可理解。
- 大输出提供 query/filter/range/pagination/concise 模式。
- 错误默认变成可供模型修复的结构化结果；只有未知/不可恢复错误抛出。
- 用真实任务 eval 工具选择、参数正确率、结果利用率、token 与延迟。Anthropic 的官方工具工程建议也强调 namespacing、高信号响应和 held-out evaluation。[Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)（访问：2026-08-07）。

### 原则 8：按需发现优于全量注入

- 启动时只 advertise tool/skill 名称、用途和权限类别。
- 模型需要时再加载 schema、`SKILL.md`、reference 或 MCP tool。
- 给 context 设显式预算和来源统计，避免技能与工具数量增长后悄悄挤掉业务上下文。

### 原则 9：权限决策与 sandbox 是两条防线

- policy engine 决定 allow/ask/deny，并能按工具、路径、域、动作、环境和用户角色匹配。
- sandbox/容器负责实际文件、进程和网络边界。
- 密钥尽量保留在 agent 执行边界之外，通过 scoped credential/proxy 注入；日志默认脱敏。

### 原则 10：HITL 是运行态，不是 UI 弹窗

统一建模 `Interrupt { id, runId, reason, requestedInput, pendingAction, expiresAt }` 与 `Resume { interruptId, decision, payload }`。CLI、Web、SDK 只是呈现层；进程退出后也必须能继续。

### 原则 11：可观测性必须能回答“发生了什么、为什么、花了多少”

统一 run/turn/step/agent/tool/call IDs；events 用于实时 UI，traces 用于因果链，metrics 用于趋势，artifact/transcript 用于复盘。敏感 tool input/output 应默认不导出。

### 原则 12：评测结果与轨迹同时看

- outcome：测试是否通过、数据库/文件/工单是否处于正确状态。
- trajectory：调用了什么工具、是否越权、多少 turns/retries、是否请求了必要澄清。
- quality：代码/文本的可维护性、准确性与业务 rubric。
- efficiency：token、费用、延迟、人工介入。
- 非确定性任务运行多次 trial，并人工阅读失败 transcript 校准 grader。

## 七、CoreMind 与 Claude Code 能力矩阵

图例：✅ 已有且方向相当；🟡 有基础但明显不完整；❌ 当前未交付；🧪 必须通过评测，不能靠代码静态判断。

| 维度 | Claude Code 当前官方能力 | CoreMind 当前 | 结论 |
|---|---|---|---|
| 自主工具反馈 loop | 多 turn、工具结果回灌、turn/预算控制 | CoreMind Loop + abort/步骤护栏 | 🟡 核心成立，预算/结果状态不足 |
| coding 工具 | 文件、搜索、Shell、Web 等完整工具面 | 9 内置 + 脚本工具 | 🟡 基础覆盖 |
| 确定性 workflow | 动态 workflows/SDK 可编排 | YAML 五类步骤 | ✅ CoreMind 的新手差异化优势 |
| 计划/任务状态 | todo、plan/goal、共享 task 等 | 无一等 Plan/Task | ❌ |
| 动态 subagent | 独立 context、前后台、工具限制 | 静态 `call/parallel` | ❌ |
| 团队协调 | lead、共享任务、peer messaging（部分实验性） | 无 | ❌，非近期必需 |
| 会话 resume/fork | resume/continue/fork | resume；无公开 fork/tree UX | 🟡 |
| context compaction | 自动/手动、重注入规则、可观测 context | 可选非破坏压缩 | 🟡 |
| 指令/记忆分层 | CLAUDE.md、rules、auto memory、subagent memory | systemPrompt + session | ❌/🟡 |
| skills | 标准结构、按需加载、资源/脚本、插件分发 | README 全文预注入 | 🟡 |
| MCP/工具发现 | stdio/HTTP/OAuth/resources/tool search | 无 | ❌ |
| hooks/middleware | 大量生命周期，可阻断/改写/审计 | 无 | ❌ |
| 权限/HITL | allow/ask/deny、审批与澄清回到 loop | 无统一策略/可持久化 interruption | ❌ P0 |
| sandbox/egress | OS 级文件/网络隔离 | 无 CoreMind 层实现 | ❌ P0 |
| durable workflow | SDK session +外部存储；产品 checkpoint | 只持久化主 Agent messages | ❌ P0 |
| 幂等/副作用恢复 | 可由 SDK/harness 构建，产品有多层边界 | 无通用契约 | ❌ P0 |
| 文件 checkpoint/rewind | 直接编辑工具可回退；Bash 有明确限制 | 无 | ❌ |
| 事件/streaming | 丰富 lifecycle/message/tool events | 8 类归一事件 | 🟡 |
| trace/OTel | metrics/events/traces | 结束后 quality summary | ❌/🟡 |
| SDK/非交互自动化 | TS/Python SDK、print/JSON/CI | TS 库 + CLI/JSON events | 🟡 |
| eval | 官方方法论，可用 SDK 自建；未发现通用内置 runner | faux/单测/真实 LLM smoke，无 agent eval suite | ❌ |
| 真实任务质量 | 需同环境 benchmark | 未与 Claude Code A/B | 🧪 未验证 |

### 矩阵结论

CoreMind 不是“只有一个聊天壳”；它已经越过了 L0。但与 Claude Code 的关键差距主要在 L2 的**安全、durability、context、扩展和 eval**，而不是再添加几个 if/switch 语法。若先追求 Web 面板或更多模板而跳过这些基础，产品会“更好看但不更可信”。

## 八、供选择的优化路线

### 方案 A：CoreMind Native Production Harness（推荐）

**目标**：保持 `coremind.yaml` 的低门槛和轻量核心，不追求完整 Claude Code UI；先补齐任何领域 agent 都需要的生产底座。

建议顺序：

1. **P0 Tool Execution Envelope**
   - 所有工具必须经过统一 executor，不允许 registry 直接把原始工具交给 Agent。
   - executor 统一做 schema 校验、timeout、retry 分类、permission、approval、sandbox adapter、redaction、trace、idempotency。
   - 权限配置先支持 `allow/ask/deny`、工具名、文件路径、网络域、read/write/execute/side-effect 分类。
2. **P0 Durable RunState + Interrupt/Resume**
   - 新建独立于 conversation session 的 `RunState`；记录 step attempt、输入摘要、输出/错误、pending approval、receipt、checkpoint version。
   - 每一步状态迁移写 append-only event；进程崩溃后从最后稳定边界恢复。
   - 首批验收必须包含“外部副作用成功后进程崩溃，恢复不重复执行”。
3. **P0 Eval & Trace**
   - 增加 `coremind eval <suite>`：任务集、多 trial、deterministic/outcome/trajectory/rubric graders、费用/耗时/token/tool error 指标。
   - 事件补充 `runId/turnId/stepId/attempt/toolCallId/timestamp/duration/usage/stopReason`，提供 OTLP exporter seam。
4. **P1 MCP + Tool/Skill Progressive Disclosure**
   - 先做 MCP stdio + Streamable HTTP、静态 allowlist/filter、超时/输出上限；OAuth 可后续。
   - skills 迁移到标准 `SKILL.md`，启动只加载 name/description，需要时再 read resource/run script。
5. **P1 Hooks/Middleware**
   - 提供稳定的 pre/post model、pre/post tool、permission、step、session、compaction、stop hooks。
   - hooks 通过同一事件/决策协议返回，不直接耦合 CLI。
6. **P2 Context Providers 与可选动态委派**
   - 分离 instructions、working state、conversation、memory、artifacts。
   - 动态 subagent 先只支持“独立 context + 有界并发 + 返回摘要”，暂不做 agent team/peer messaging。

**优势**：最符合 CoreMind 原定位；所有能力都能通过 YAML 暴露给新手；不会把框架变成 Claude Code 克隆。
**代价**：durability 与安全语义需要严谨设计，短期看不到炫目的 UI 增量。
**成功定义**：达到“安全、可恢复、可诊断、可回归”的通用 harness，而非 Claude Code 全功能同款。

### 方案 B：增加可选 `coding` profile，复用上游 coding harness

**目标**：更快接近 Claude Code 的 coding-agent 体验，同时不污染通用 runtime。

建议形态：

- 新建独立 adapter/package，例如 `coremind-profile-coding`，内部评估 `createAgentSession()` / `AgentSessionRuntime` / `ResourceLoader` / `SessionManager`。
- YAML 只暴露稳定的 CoreMind 概念；上游 extensions、skills、session tree、compaction、RPC 通过 adapter 映射。
- CoreMind 自己的 permission envelope、审计和配置校验仍包在外层，不能因为上游有 extension 示例就默认安全。
- 固定兼容版本并建立 contract tests；当前本地 `^0.83.0` 与远程 main/历史本来就可能漂移。

**优势**：可复用上游已有的 coding session/resource/extension 机制，避免重写。
**代价**：包体、API 耦合和升级面扩大；coding profile 的复杂度不适合所有业务 agent。
**适用条件**：用户明确把“像 Claude Code 一样改代码、长会话、分支/恢复、扩展”列为核心场景。

### 方案 C：为长流程增加可选 LangGraphJS durable backend

**目标**：保留 CoreMind Loop 作为 Node 内的自主执行器，把复杂、长周期业务 workflow 编译到成熟的 state/checkpoint runtime。

先做受控 spike，不直接切换默认引擎：

1. 同一份内部 workflow IR 分别跑 local engine 与 LangGraphJS adapter。
2. 用三个真实样例验收：审批暂停后跨进程恢复、并行分支一支失败后不重跑已成功分支、外部副作用崩溃后不重复。
3. 比较代码量、调试透明度、Windows/SQLite/Postgres 部署、schema 映射和新手错误信息。
4. 只有 adapter 明显降低 durability 风险且不破坏 YAML 心智模型时，才保留 `engine: durable` 选项。

**优势**：checkpoint/interrupt/time travel/retry 等语义已有成熟参考。
**代价**：引入第二套执行模型和新的抽象层；简单任务不应承担该成本。
**不建议**：现在就把所有 CoreMind workflow 全量重写成 graph。

### 方案 D：完整追赶 Claude Code 产品面（不建议作为当前默认路线）

需要额外建设：背景 sessions、动态 workflows/agent teams、共享任务、worktree 隔离、文件 rewind、auto memory、plugins/marketplace、IDE/Web/CI、企业策略、遥测与成本治理。这已经不是“优化当前框架”，而是产品定位和资源规模的重大改变。

只有用户明确把 CoreMind 改为 coding-agent 产品，并接受通用低代码框架让位时，才应选择此路线。

## 九、建议的近期架构切面

以下只是概念接口，不是已确认 schema：

```text
coremind.yaml
    ↓ parse / validate / defaults / warnings
Config IR
    ↓ compile
AgentSpec + WorkflowSpec + PolicySpec + EvalSpec
    ↓
Durable Runner
    ├─ Context Manager      # 从事实日志构造模型视图
    ├─ Tool Executor        # schema/permission/sandbox/retry/idempotency
    ├─ Interrupt Broker     # ask/approve/clarify/resume
    ├─ Checkpoint Store     # RunState，不等于会话 transcript
    ├─ Event/Trace Bus      # UI、OTel、审计、eval 共用
    └─ Agent Runtime Adapter # 模型决策与 tool loop
```

需要守住的依赖原则：

- `Agent Runtime Adapter` 不直接持久化业务 RunState。
- 工具只能由 `Tool Executor` 调用。
- CLI/TUI/Web 只能消费 event/interrupt，不拥有运行语义。
- context manager 只读 append-only facts，生成可丢弃视图。
- eval runner 使用与生产完全相同的 Runner 和 Tool Executor，不能另写一条“测试专用简化路径”。

## 十、如何真正验证“达到 Claude Code 水平”

### 10.1 对照实验要求

要隔离 harness 影响，至少满足：

- 同一 Claude 模型版本、temperature/effort 和 token/费用上限。
- 同一初始 Git commit、同一操作系统镜像/依赖缓存、同一网络条件。
- 尽可能同构的 read/search/edit/bash/web 工具与权限范围。
- CoreMind 走公开库/CLI；Claude Code 走 `claude -p` 或 Agent SDK 非交互模式。
- 每个任务至少多次 trial；随机顺序执行；保留完整 transcript、diff、环境结果与费用。

若模型不同，得到的是“产品组合比较”，不能归因于 harness。

### 10.2 最小任务集

建议首版 30–40 个真实任务，而不是 100 个玩具题：

| 类别 | 要验证的 harness 能力 | 示例 |
|---|---|---|
| Repo 理解 | 检索、上下文选择、指令遵循 | 找到跨包调用链并给证据 |
| Bug 修复 | 诊断→改动→测试反馈 loop | 预置失败测试，修复且不改无关文件 |
| 小功能 | 计划、实现、验证 | 新增受限 API，含测试/文档 |
| 重构 | 长 context、回归控制 | 保持行为不变的跨文件迁移 |
| 工具故障 | 可恢复 error 与 retry | 首次 API 429、工具参数错误 |
| 模糊需求 | ask/interrupt | 缺关键业务选项时必须暂停 |
| 高风险动作 | permission/sandbox | 尝试越界写文件/联网/读取 secret |
| 崩溃恢复 | checkpoint/idempotency | side effect 后 kill 进程再恢复 |
| Context 压力 | compaction/memory | 超长日志 + 中途续接仍保留约束 |
| 长周期交付 | 增量进度与 done contract | 多 session 完成一组可验收 features |

### 10.3 Grader 组合

- deterministic：单测、typecheck、lint、安全扫描、文件 allowlist、无 secret 泄露。
- outcome：目标文件/数据库/工单最终状态，以及副作用恰好一次。
- trajectory：必需/禁用工具、越权尝试、turns、重复读取、retries、澄清与审批。
- model rubric：代码质量、需求一致、不过度设计；rubric 需 few-shot 校准。
- human review：抽样阅读所有失败与一部分通过 transcript，检查 grader 是否公平。

### 10.4 建议的声明门槛

以下是**建议标准，不是行业事实**：

在公开声称“达到 Claude Code 级 harness”前，至少应同时满足：

1. 在同模型同预算任务集上，核心 outcome 成功率与 Claude Code 的差距落在预先声明的非劣界限内（例如 5 个百分点），并给置信区间。
2. P0 安全任务无越界副作用；所有高风险动作均被阻止或产生可恢复审批。
3. 注入崩溃的恢复任务 100% 不重复已经确认的副作用。
4. 每个 trial 都能从 trace 关联到 model call、tool call、permission、checkpoint 和最终 outcome。
5. 至少一个超过单 context 的真实项目任务能跨 session 延续，并由端到端测试验证完成，而不是 agent 自报完成。

在完成该评测前，对外更准确的措辞是：**“CoreMind 已具备基础自主循环和配置工作流，正在补齐生产级 harness 能力。”**

## 十一、推荐决策

### 如果只能选一条路线

选择 **方案 A**，顺序固定为：

1. permission/approval + sandbox seam；
2. durable RunState + interrupt/resume + idempotency；
3. trace + eval；
4. MCP + progressive skills；
5. hooks/middleware；
6. 最后再决定 dynamic subagent、LangGraph adapter 或 coding profile。

理由不是“功能越多越好”，而是这六项共同构成新手敢用、开发者能排错、维护者可回归的最小生产闭环。

### 如果目标明确是尽快接近 Claude Code 的 coding 体验

在方案 A 的安全/持久化契约确定后，并行做 **方案 B 的小型 adapter spike**。用真实 repo 样例验证上游 coding harness 的 session tree、resource loader、extensions、skills、RPC 是否能以稳定而简化的 YAML 暴露；不要先复制 UI。

### 现在不建议做的事

- 不建议为了“显得 agentic”引入无限 loop、自由递归 subagents 或默认 agent team。
- 不建议把 `RunQuality` 改名为 eval；统计不是质量判定。
- 不建议把会话 JSONL 当作 durable workflow state。
- 不建议直接暴露 MCP/第三方 skill 的任意工具或脚本而没有信任/权限层。
- 不建议先上 Web 面板再补事件关联 ID 和恢复协议；UI 会固化错误契约。
- 不建议整体替换底层运行库；当前主要差距在 CoreMind harness 层，而不是基础模型 loop 不存在。

## 十二、信息缺口与风险

1. Claude Code 是闭源产品；官方文档能验证外部行为与 SDK 契约，不能验证内部所有实现细节。
2. Claude Code、OpenAI Agents SDK、ADK 和 Microsoft Agent Framework 在 2026 年仍快速变化；本文是 2026-08-07 快照，实施前应重新核对具体 API/feature availability。
3. 部分 Claude Code 能力依赖计划、模型、平台或实验开关；本文描述“官方存在”，不代表每个账户/环境默认可用。
4. 本次未运行 CoreMind vs Claude Code benchmark、渗透测试、长周期 crash recovery 测试或 TUI 人工体验。
5. 当前 CoreMind 使用锁定的上游运行库版本；上游主分支的新能力不能视为已安装版本的保证，adapter 必须以锁定版本和 contract tests 为准。
6. CoreMind 现有事件归一化丢弃了部分上游细节；扩展事件 schema 时需要版本化，避免破坏 CLI/Web/库消费者。
7. sandbox 在 Windows、macOS、Linux 的实现与保证不同；选择具体组件前必须用真实平台样例验证，不能只靠 README 宣布完成。

## 十三、官方来源清单

所有来源访问日期均为 **2026-08-07**。

### Anthropic / Claude Code

- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [How the Agent SDK loop works](https://code.claude.com/docs/en/agent-sdk/agent-loop)
- [Claude Code features overview](https://code.claude.com/docs/en/features-overview)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Context window](https://code.claude.com/docs/en/context-window)
- [Memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Skills](https://code.claude.com/docs/en/skills)
- [Checkpointing](https://code.claude.com/docs/en/checkpointing)
- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Monitoring and OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Headless/programmatic use](https://code.claude.com/docs/en/headless)
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Harness design for long-running applications](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)

### OpenAI Agents SDK

- [Official TypeScript repository](https://github.com/openai/openai-agents-js)
- [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)
- [Agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/)
- [Human in the loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/)
- [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/)
- [MCP](https://openai.github.io/openai-agents-js/guides/mcp/)
- [Sandbox Agents](https://openai.github.io/openai-agents-js/guides/sandbox-agents/)

### LangGraph

- [Official repository](https://github.com/langchain-ai/langgraph)
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)
- [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
- [Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)
- [Graph API](https://docs.langchain.com/oss/javascript/langgraph/use-graph-api)

### Google ADK

- [Official TypeScript repository](https://github.com/google/adk-js)
- [Workflows](https://adk.dev/workflows/)
- [Template workflows](https://adk.dev/agents/workflow-agents/)
- [Session, State and Memory](https://adk.dev/sessions/)
- [State](https://adk.dev/sessions/state/)
- [Evaluation criteria](https://adk.dev/evaluate/criteria/)
- [Custom evaluation metrics](https://adk.dev/evaluate/custom_metrics/)
- [Agent Config](https://adk.dev/agents/config/)

### Microsoft Agent Framework / AutoGen

- [Microsoft Agent Framework repository](https://github.com/microsoft/agent-framework)
- [Agent Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/)
- [Middleware](https://learn.microsoft.com/en-us/agent-framework/journey/adding-middleware)
- [Workflow events](https://learn.microsoft.com/en-us/agent-framework/workflows/events)
- [Workflow observability](https://learn.microsoft.com/en-us/agent-framework/workflows/observability)
- [Agent Skills](https://learn.microsoft.com/en-us/agent-framework/agents/skills)
- [AutoGen repository and maintenance notice](https://github.com/microsoft/autogen)

### 底层运行库

- 上游官方仓库（内部依赖审计记录）
- Agent loop 源码（内部依赖审计记录）
- Coding SDK、Session、Compaction、Skills 与 README（内部依赖审计记录）
