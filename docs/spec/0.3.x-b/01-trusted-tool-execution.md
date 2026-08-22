# 0.3.x-B 规格：可信工具执行

> 配套 ADR：[0004-trusted-tool-effects-and-durability](../../adr/0004-trusted-tool-effects-and-durability.md)
> 状态：accepted（2026-08-22 用户确认）
> 本规格只冻结内部语义，不授权实现、依赖升级、Issue、真实外部调用或发布

## 1. 目标与非目标

本批目标是让 CoreMind 对每次工具调用回答五个相互独立的问题：工具代码是否运行、外部 Effect 是否可能发生、关键 Fact 是否持久、恢复时可否重放、资源是否清理完成。

本批不引入 MCP、远程执行、Subagent、SQLite 强制依赖或新的公共权限档；`ask / assisted / full` 的公开含义保持不变。

## 2. 唯一 Tool Capability

每个 Call 在 Policy 之前解析为不可变的 `ResolvedToolCapability`。它是以下消费者的唯一输入：Policy、Approval、Checkpoint、执行 lane、EffectReceipt、Resume、Projection 与 UI。

| 维度 | 允许值 | 说明 |
| --- | --- | --- |
| `effect` | `none / workspace / process / network / external / unknown` | 调用可触达的状态边界 |
| `replay` | `safe / idempotent / unsafe / unknown` | 相同参数再次执行的恢复语义 |
| `concurrency` | `parallel / run_serial / workspace_exclusive` | 最宽允许并发；后续 Policy 只能收紧 |
| `checkpoint` | `none / required / unsupported` | 是否需要 Workspace Checkpoint |
| `durability` | `ordinary / critical` | 执行前必须达到的 Store 等级 |
| `source` | `builtin / registered / inferred / fallback` | 能力声明来源，用于审计而非降低限制 |

### 2.1 单调安全

- 未注册、缺字段、冲突或无法解析的工具统一为 `effect: unknown`、`replay: unknown`、`concurrency: run_serial`、`durability: critical`。
- Config、Extension、Host 或入口只可维持或收紧能力，不能把 `unknown` 降为 `none`，也不能把 `unsafe` 升为 `safe`。
- 工具实现可提供幂等证明，但最终能力由 CoreMind 解析并写入 Fact；只靠名称白名单不得决定安全性。
- `web-fetch`、`web-search` 等网络读取至少是 `effect: network`，规范术语为 External Observable Read，不能归入纯本地读取。

### 2.2 典型映射

| 工具行为 | effect | replay | concurrency | checkpoint |
| --- | --- | --- | --- | --- |
| 读取已知 Workspace 内文件 | `none` | `safe` | `parallel` | `none` |
| 写入 Workspace 文件 | `workspace` | 由调用证明 | `workspace_exclusive` | `required` |
| 启动本地进程 | `process` | 默认 `unknown` | `run_serial` | 按目标声明 |
| 访问网络 API | `network` | 默认 `unknown` | `run_serial` | `none` |
| 未知 Python/Script/第三方工具 | `unknown` | `unknown` | `run_serial` | `unsupported` 或 `required` |

## 3. Tool Call 生命周期

```text
call_recorded
  → capability_resolved
  → policy_resolved
  → approval_resolved
  → lease_acquired
  → checkpoint_durable
  → started_durable
  → executing
  → observed
  → result_durable
  → terminal
```

- 不需要的阶段仍以规范化 `skipped(reason)` 表达，不允许入口直接绕过 ToolExecutionEngine。
- side-effect-capable 或 unknown Call 在 `started_durable` 之前不得调用 Tool Adapter。
- `started` Receipt 与必要 Checkpoint 任一 Durability Barrier 失败，Call 终止为 `blocked_before_execution`，真实 Effect 次数必须为 0。
- Tool Adapter 返回不等于结果已持久；`observed` 与 `result_durable` 是两个事实时刻。
- Effect 可能发生但结果无法确认时，EffectState 必须为 `unknown`，不能回退为 `not_started`。

## 4. 正交结果

每个 Tool Call 投影至少包含：

| 轴 | 建议值 |
| --- | --- |
| ExecutionOutcome | `not_invoked / returned / threw / timed_out / aborted` |
| EffectState | `not_started / started / committed / unknown` |
| PersistenceState | `pending / durable / failed / unknown` |
| RecoveryDisposition | `replay_safe / requires_proof / requires_human / forbidden` |
| CleanupState | `not_needed / pending / quiescent / failed` |
| AuthorizationState | `allowed / approved / denied / expired` |
| EnvironmentState | `available / degraded / unavailable` |

这些轴不能相互覆盖。例如 `ExecutionOutcome: threw` 不能推出 `EffectState: not_started`；`PersistenceState: failed` 也不能抹去 Tool Adapter 已返回的观测事实。

## 5. Durability Barrier

Store 必须在初始化时声明能力，至少区分：

- `ordinary`：允许批量写；适用于 token delta、UI progress 和非安全关键观测。
- `critical`：调用方得到成功确认后，安全关键 Fact 已达到 Store 对该平台声明的持久化边界。

审批、`started` Receipt、关键 Tool Result、Effect 终态、Run pause/finish 必须使用 `critical`。Store 若不支持请求等级，ToolExecutionEngine 在执行前失败关闭；不得把“进入 Promise 队列”或“内存中可见”当成 barrier 成功。

Store Adapter 必须公开 `supportedDurability` 与失败原因。跨进程崩溃和系统/掉电边界的精确定义由 Adapter 文档与平台探针证明，Runtime 不得把较弱等级宣传为较强等级。

## 6. Workspace Lease 与执行 lane

- Workspace 身份是解析 symlink/junction、大小写与相对路径后的 canonical root。
- 同一 canonical Workspace 允许并行纯读；同一时刻只允许一个 Run 或 Child Run 持有写租约。
- 获取租约发生在 Checkpoint 和 `started_durable` 之前；释放发生在工具工作、子进程与尾部写入全部 Quiescent 之后。
- 其他写任务可以排队或明确返回 `workspace_busy`，但不能无租约执行。
- 只有 canonical root 彼此隔离且无共享写目标时，多个 Run/Worker 才能并行写。
- 进程或网络工具默认在 Run 内串行；只有 Capability 明确证明可交换或幂等时才允许更宽并发。

## 7. External Observable Read 恢复

任务中断后按以下顺序处理网络读取：

1. 已有持久化、参数指纹匹配的结果：复用，不联网。
2. Capability 与 Receipt 能证明安全重放：允许重试，并追加新的 attempt Fact。
3. 无法判断请求是否到达远端：EffectState 为 `unknown`，暂停并请求用户决定。

正常首次联网仍遵循现有网络权限；本规则不增加“每次网络读取都审批”的公开行为，只禁止恢复端无条件重复请求。

## 8. 兼容与迁移

- `0.3.x-B` 不破坏 Config v2、Protocol v1 和现有公共结果结构；新字段以可选追加或内部投影形式进入。
- `0.3.0/0.3.1` 历史记录缺少 Capability、Barrier 与 Lease Fact 时，读取端按当时可知事实降级，不伪造 `started_durable`。
- 历史 Call 若已知工具调用存在但无法判定 Effect，RecoveryDisposition 至少为 `requires_human`。
- 四入口只能消费同一个 ProjectionEngine 结果，Worker 不得独立推导 `resumable`。

## 9. 完成定义

本规格只有在[验收矩阵](02-acceptance-matrix.md)全部通过、Standards/Spec 双轴审查无阻断、Windows/Linux 平台证据齐全后才算实现完成。通过不等于真实 Provider 认证、产品验收或发布授权。
