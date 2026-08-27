# 0.4.x 规格：Protocol v2 与 v1 迁移

> 配套 ADR：[0006-protocol-v2-with-v1-migration](../../adr/0006-protocol-v2-with-v1-migration.md)
> 目标：`0.4.0` 引入 v2；整个 `0.4.x` 保留 v1 兼容入口
> 状态：accepted（2026-08-22 用户确认）
> 实现状态：#71 已合入 `main` 并通过 Ubuntu/Windows CI；尚不代表 `0.4.0` 发布或真实远程 Host 认证

## 1. 目标

Protocol v2 为 CLI、TUI、TypeScript、Python、未来 Web 与远程 Host 提供同一套：

- 显式版本与能力协商；
- 启动后立即返回 RunHandle；
- 类型化、可续订事件；
- Cancel、Approval、Steering、Follow-up 等控制回执；
- RunSnapshot、RecoveryDecision、Context 与 Artifact Projection Query；
- 断线后按 cursor 续订，而不改变 Runtime 权威状态。

Protocol Host 只是单一 Node Runtime 的入口 Adapter，不拥有第二份 Run 状态机。

## 2. 版本协商

`initialize` 请求声明客户端支持的协议范围与可选能力；Host 返回选中的唯一版本、Server capabilities、schema fingerprint 和迁移提示。

规则：

- 无交集时返回 `protocol_version_unsupported`，不得猜测或静默降级。
- v2 客户端不得在一次连接中混用 v1 request/notification envelope。
- 未知且未标记 ignorable 的事件或字段组合失败关闭。
- 能力协商只声明入口功能，不扩大 Config、Permission、Tool Capability 或 Execution Environment。

## 3. RunHandle

run/chat/resume 接受客户端预生成的稳定 RunId，并在任务进入后台执行后立即返回。SDK 可以在调用方省略时本地预生成，但 Host v2 线协议不补造 RunId：

```text
RunHandle = RunId
          + acceptedAt
          + initialCursor
          + selectedProtocol
          + availableControls
```

返回 RunHandle 只表示请求被接收，不表示 Run 已开始调用 Provider、工具已授权或终态成功。

同一 RunId 的重复 start 请求必须通过输入指纹决定幂等返回或 `run_id_conflict`；不得启动第二个 Run。

首次 run/chat 结束后，resume 可以用同一 RunId 承接；resume 自身的重复请求仍按完整 start 指纹幂等或冲突。

## 4. 类型化事件 envelope

每条事件至少包含：

- protocol version、event type 与 event schema version；
- RunId、单调 sequence、eventId 与 timestamp；
- 可选 TurnId、StepId、CallId、ApprovalId、ReceiptId、ChildRunId；
- payload；
- `ignorable` 与敏感级别元数据。

sequence 是 Run 内 cursor，不是全局时钟。重连客户端用 `afterSequence` 续订；Host 可重复发送已交付事件，客户端按 `(RunId, sequence, eventId)` 去重。

token delta 与 UI progress 可以是可丢弃 live event；安全关键事件必须引用 durable Fact。客户端不得把 live event 当成 Resume 的权威事实。

## 5. 控制回执

每个控制命令使用稳定 ControlId，并返回：

| 状态 | 含义 |
| --- | --- |
| `accepted` | 已进入 ControlInbox，尚未证明生效 |
| `applied` | 已转换为对应 Runtime Fact |
| `rejected` | 违反状态、权限、身份或版本合同 |
| `duplicate` | 同 ControlId 与同指纹已处理 |
| `conflict` | 同 ControlId 对应不同内容 |

Cancel ACK 不是 Quiescent；客户端应查询或订阅 Abort、terminal 与 Quiescent Projection。Approval、Steering 和 Follow-up 同样先进入持久 ControlInbox，不能只存在于连接内存。

## 6. Projection Query

v2 查询只调用 ProjectionEngine，至少覆盖：

- RunSnapshot 与 RunOutcome；
- RecoveryDecision 与不可恢复原因；
- pending Approval/Control；
- Context budget/compaction 与 Artifact 引用；
- Child Run tree；
- local observability 与 Telemetry sharing status。

查询结果携带 `derivedFromSequence`；它可以过期和重建，不能写回 Fact 或成为控制授权。

## 7. 断线与重连

- 客户端断线不 Cancel Run，除非启动请求明确声明连接所有权策略。
- Host 重启后从 Fact 重建活动 Run 与 cursor；无法安全 Resume 的 Run 进入明确 paused/unknown，而不是重复 Provider 或工具调用。
- cursor 早于可用保留范围时返回 `cursor_expired`，并提供从 Projection snapshot + 新 cursor 继续的受控路径。
- 重连不能重新应用已经 `applied` 的 Control，也不能丢失 pending Control。

## 8. v1 兼容 Adapter

- 整个 `0.4.x` 提供 v1 入口；内部立即映射到同一 RunKernel/ProjectionEngine。
- v1 原有同步 run/chat 可继续等待终态，但不承诺 RunHandle、cursor 续订、全部 v2 query 或 Child Run tree。
- v1 与 v2 对共同能力必须产生等价 Fact、RunOutcome 和 RecoveryDecision。
- v1 响应包含迁移提示，但不能把提示当作运行错误。
- v1 最早到 `0.5.0` 才可考虑移除；移除前需独立 ADR、使用证据、迁移指南、双 SDK 版本计划与用户批准。

## 9. 安全与失败

- 所有身份、路径、控制内容和注册工具 Schema 在 Host 边界验证；Host 不能信任客户端声称的内部品牌类型。
- 协议错误、慢消费者、连接断开和序列化失败不得污染 Run Fact 或改变 Tool Effect。
- event payload 遵循本地/外传不同敏感边界；Protocol 可传递本地授权内容，但 OTel 仍执行独立 egress policy。
- Python SDK 继续是协议客户端，不创建纯 Python Runtime。

## 10. 验收门

- v2 schema 生成与兼容快照；未知版本/事件负向测试。
- v1/v2 × CLI/TUI/TS/Python 对共同场景的 Fact、Outcome 与 RecoveryDecision 等价。
- start/duplicate/conflict、断线、Host crash、cursor replay、慢消费者、Control 重复与 Cancel-to-Quiescent 故障注入。
- v1 在整个 0.4.x 的迁移 fixture；未授权前不存在移除代码。
- Windows/Linux Worker 与真实入口通过；真实远程 Host/网络部署另行授权。

#71 合并候选已验证真实 stdio Worker、Python 捆绑 Worker 与 Ubuntu/Windows CI；真实远程 Host、网络部署与 `0.4.0` 发布仍是独立门禁。

这里的“v1/v2 × 四入口”是共享 Runtime 的语义矩阵，不要求本地 CLI/TUI 增加协议选择开关：#70 的四入口验收固定 CLI、TUI、TypeScript 与 Python 的共同 Fact、Outcome、RecoveryDecision；#71 的 ProtocolHost 验收再固定 v1/v2 对同一 Runtime 输入与完成态共同 Fact、Outcome、RecoveryDecision 的等价。两段证据都通过才关闭该矩阵，v2 专属 RunHandle、start identity、cursor 与 query 元数据不参与 v1 共同能力比较。
