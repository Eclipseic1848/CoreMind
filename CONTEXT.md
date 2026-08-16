# CoreMind

CoreMind 是配置驱动的智能体开发框架。本文件是领域术语表：工程 Skills、Issue、重构方案与测试名称统一使用这里的词汇。术语定案过程见 [docs/agents/domain.md](docs/agents/domain.md)。

## Language

### 执行与交互

**Run**：
一次完整的执行尝试：从创建到终态（succeeded / failed / aborted / timeout / budget_exceeded）或 paused（可 Resume）。每次 Run 拥有持久 RunState 与唯一 RunId。
_Avoid_: 执行、一次对话、session（Run 与 Session 是不同事实域）

**Turn**：
Agent 与 Provider 的一次模型请求-响应回合，含该回合内产生的工具调用与结果。一个 Run 包含一个或多个 Turn。每次 Turn 拥有唯一 TurnId。
_Avoid_: 轮次、回复、step

**Step**：
Loop 或 Workflow 中的稳定执行单元（planning / executing / verifying / repairing 等）。StepId 在 Run 内唯一。
_Avoid_: 阶段、环节、task

**Call**：
一次工具调用的执行。Call 属于某个 Run 与 Turn。每次 Call 在 Trace 中以 CallId（上游 toolCallId）标识。
_Avoid_: 工具执行、invocation

**Session**：
跨 Run 的消息事实域：用户消息、助手消息、工具调用与结果的未脱敏全量持久记录（会话树）。
_Avoid_: 用 Session 指代单次 Run、RunState 或交互控制器

### 事实与投影

**Fact（事实）**：
追加式、不可变、持久的记录，是恢复与审计的权威来源。分三个互不重叠的事实域：

- **Session 事实**：会话树（消息全量，未脱敏）；
- **Run 事实**：RunState journal（事件、operation、loop 快照、checkpoint 引用，脱敏）；
- **Workspace 事实**：checkpoint 文件内容（文件前后快照）。

各域通过关联键（RunId、SessionId + 条目 seq、CheckpointId）显式连接，不做物理合并。
_Avoid_: 状态、日志、快照（Snapshot 是投影）

**Projection（投影）**：
从事实派生的可丢弃视图（RunSnapshot、会话上下文视图、CheckpointDiff、metrics、TUI 状态）。投影可随时从事实重建，不承载权威信息。
_Avoid_: 视图、模型、缓存

**Rebuild（重建）**：
从持久事实规范化地重新生成投影或 Provider 请求的过程。请求可重建是验收不变量：从事实重建的每次 Provider 请求与实际发送值一致。
_Avoid_: 恢复、重放

### 收据与身份

**EffectReceipt（副作用收据）**：
一次工具调用副作用的状态定案，取值 not_started / started / committed / unknown。以 ReceiptId（即规范化 idempotencyKey）标识。
_Avoid_: 结果、执行记录

**InputReceipt（输入收据）**：
一次外部输入的接收状态定案，取值 pending / claimed / discarded / completed。每个外部输入有稳定输入 ID。
_Avoid_: 消息收据、prompt 记录

**Branded ID（品牌 ID）**：
带编译期品牌类型的标识（RunId / TurnId / StepId / CallId / ApprovalId / ReceiptId / CheckpointId 等），协议边界上仍序列化为字符串并做格式校验。
_Avoid_: 普通 string ID、uuid

### 取消与恢复

**Cancel（取消请求）**：
来自外部的停止请求（信号、协议消息、预算超限、超时）。
_Avoid_: 中止、abort（Cancel 是请求，Abort 是事实）

**Abort（中止事实）**：
活动已被终止写入事实的时刻。Abort 生效时刻是事件准入的分界点：此后属于旧活动的终态事实不得再写入。
_Avoid_: 用 Abort 指代用户请求

**Quiescent（静止）**：
无在飞活动（Agent 空闲、无未落定工具、无未 flush 的 journal 写入）的状态。取消收敛的验收目标是到达 Quiescent。
_Avoid_: 空闲、已停止

**Resume（续跑）**：
从中断的 Run 持久状态继续执行（冷恢复）。
_Avoid_: 恢复（与 Restore 混用）

**Restore（撤销恢复）**：
把 Workspace 文件恢复到 Checkpoint 记录的状态（显式用户动作）。
_Avoid_: 恢复（与 Resume 混用）
