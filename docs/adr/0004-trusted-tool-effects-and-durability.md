# 可信工具执行、单调安全与分级持久化

CoreMind 已有权限、Checkpoint 与 EffectReceipt，但工具能力分类分散，安全关键 Receipt 进入内存队列后工具即可开始，多个 Runtime/Worker 也可能同时写同一 Workspace。本决策声明：所有工具调用先解析唯一 Tool Capability，再经过统一 ToolExecutionEngine；side-effect-capable 或 unknown 工具只有在必要 Checkpoint 与 `started` Receipt 通过 Durability Barrier 后才能执行。External Observable Read 不等于 Pure Local Read，Resume 时不得无条件重放；同一规范化 Workspace 默认采用单写者租约。

## Status

accepted（2026-08-22 用户确认）

## Considered Options

- **维持分散分类与异步落盘**：被否。Policy、Checkpoint、Resume 和并发可能对同一工具给出互相矛盾的判断，进程故障也可能留下“副作用已发生但 started Fact 不存在”的窗口。
- **所有工具全局串行并同步每条事件**：被否。安全但过度牺牲 Pure Local Read、token delta 与 UI progress 的吞吐，且仍没有解释不同 Effect 的 RecoveryDisposition 语义。
- **统一能力 + 分级持久化 + 执行 lane**（采纳）：安全关键 Fact 使用强 Durability Barrier，普通事件允许批量写；Pure Local Read 可有界并行，Workspace write 持有独占 Lease，其他外部 Effect 按能力与幂等证明决定串行和 RecoveryDisposition。

## Consequences

- Capability、Policy、Checkpoint、Receipt、Concurrency、Resume 和 UI 必须消费同一个 `ResolvedToolCapability`，未知声明按最严格边界处理。
- 工具调用按 `call_recorded → policy_resolved → lease/checkpoint → started_durable → executing → observed → result_durable → terminal` 收敛；任何前置安全阶段失败都不得调用 Tool Adapter。
- 执行结果、Effect 状态、持久化状态、RecoveryDisposition 和清理状态正交表达；工具报错不能证明副作用未发生。
- Store 必须声明可提供的 durability 等级；无法满足安全关键 Fact 所需等级时，不得承载副作用工具。无法证明的 EffectState 为 `unknown`，RecoveryDisposition 禁止自动重试。
- 详细合同与验收见 [0.3.x-B 可信工具执行规格](../spec/0.3.x-b/01-trusted-tool-execution.md)和[验收矩阵](../spec/0.3.x-b/02-acceptance-matrix.md)。
