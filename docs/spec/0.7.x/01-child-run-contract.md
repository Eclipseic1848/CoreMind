# 0.7.x 规格：Child Run 合同

> 配套 ADR：[0008-subagents-as-child-runs](../../adr/0008-subagents-as-child-runs.md)
> 状态：accepted；未发布源码候选已实现（2026-08-27）
> 本实现仍属于 `0.7.x`，没有改写 `0.3.x`/`0.4.x` 的公开发布状态

## 1. 定义与非目标

Child Run 是由父 Run 委派的完整 Run。它拥有自己的 RunId、Turn/Step/Call、Session 关联、预算、权限、Tool Capability、EffectReceipt、Checkpoint、RunOutcome、RecoveryDecision 与 Quiescent 状态。

本规格不要求 UI 展开所有细节；“一次委派”可以是简洁 Projection。Child Run 不是普通 Tool Call、共享父状态的后台 Promise，也不是绕过 Runtime 的独立 Agent 进程。

## 2. 父子身份

创建 Fact 至少包含：

- ParentRunId、ChildRunId 与 DelegationId；
- 发起父 TurnId/StepId；
- 任务输入指纹与有界可见上下文引用；
- 权限、预算、模型和 Execution Environment 的继承快照；
- Workspace identity 与 Lease 要求；
- join/cancel/orphan policy。

同一 DelegationId + 同输入指纹幂等返回同一 ChildRunId；同 ID 不同指纹返回 conflict，不得创建第二个子运行。

## 3. 权限与预算单调性

- Child Run 权限只能等于或小于父 Run；父级 `ask` 不能被子级提升为 `full`。
- 子级工具集合、网络 egress、路径范围、凭据可见性和 Execution Environment capability 只可收紧。
- 子级预算从父级显式划拨，至少覆盖 token、工具调用、费用、wall time、最大步骤与最大后代数；划拨后父级可用预算同步减少。
- Child Run 不得通过继续派生后代规避深度、并发或总预算。

## 4. Workspace 与 Effect

- Child Run 写入与父 Run 使用同一 canonical Workspace Lease 服务；父子关系不提供并行写例外。
- 子级拥有自己的 CallId 与 EffectReceipt；父级只保存 Delegation、ChildRunId 与结果引用，不复制 Receipt。
- 子级 Effect 为 committed/unknown 时，父级 Resume 不能重新创建相同委派以尝试重放。
- Workspace Checkpoint 归属执行写入的 Child Run，并通过 ParentRunId/DelegationId 回溯；Restore 仍是显式用户动作。

## 5. 生命周期与取消传播

```text
delegation_recorded
  → child_created
  → child_running
  → child_terminal | child_paused | child_orphaned
  → parent_joined | parent_detached_by_policy
```

- 默认是结构化并发：父 Run 到达相关 join 点前必须等待子级终态或明确处置。
- 父 Cancel 传播到全部活动后代；只有显式、预先接受的 durable job policy 才允许子级脱离父生命周期。
- Cancel ACK 不等于完成。父 Run 只有在后代终止/暂停、工具和进程清理、关键 Fact flush 后才能 Quiescent。
- Worker/Host 崩溃后无法确认所有权的子级进入 `child_orphaned`；Resume 处理器先执行孤儿审计，不自动重启。
- 子 Cancel 不自动 Cancel 父 Run；父级收到类型化 ChildRunOutcome 后决定继续、修复、暂停或失败。

## 6. Context 与结果

- 子级只获得任务所需的有界 Context Working Set，不默认复制父 Session 全文。
- 父级稳定规则、权限、未知 Effect 和相关文件/测试事实属于不可删除继承集合。
- 子级结果包含结构化 outcome、证据引用、Artifact、Workspace change summary 与未决风险；自然语言摘要不是唯一结果。
- 父级接收结果作为持久 InputReceipt/Delegation result，不把子级完整消息树物理合并进父 Session。

## 7. Protocol 与 Projection

- Protocol v2 事件 envelope 可携带 ParentRunId、ChildRunId 与 DelegationId；v1 不承诺 Child Run tree。
- ProjectionEngine 可重建父子树、每个节点的预算/权限/终态、活动后代与 Workspace Lease 状态。
- UI 默认显示委派摘要；展开后读取 Child Run Projection，不直接读取内部 Map 或 Worker 状态。

## 8. 限制与防护

- 默认最大深度为 3、最大活动 Child Run 数为 4、总后代数为 32；输入必须是有限非负整数。
- Child Run 不允许扩大网络、路径、工具、模型费用或凭据范围。
- 无法提供独立 Fact、取消传播、孤儿回收或 Workspace Lease 的 Agent Adapter 不具备 Subagent capability。
- MCP Tool 返回、普通并行工具和 Workflow Step 不因“工作复杂”自动成为 Child Run。

## 9. 验收门

- 父子/兄弟/三层后代的身份与预算属性测试，至少 1,000 个可复现调度种子。
- 父 Cancel、子 Cancel、父崩溃、子 Worker 崩溃、join timeout、orphan audit 与 resume 故障注入。
- 同一 Workspace 父子竞争只允许一个 Writer；隔离 Workspace 才可并行写。
- 权限、预算、网络与工具集合在任意深度保持单调不扩大。
- Effect 不重复、无孤儿进程、无悬挂 Child Run、父级 Quiescent 判定正确。
- CLI/TUI/TS/Python/未来 Web 从同一 ProjectionEngine 得到等价 Child Run tree。

本地源码候选已经实现并通过离线 Runtime、1,000 个调度种子、Windows 父/子跨进程崩溃、Workspace 双 Writer 竞争、Effect 不重放、取消后无遗留子进程及 Python bundled worker 一致性验证。真实多 Agent 产品验收、远端 CI、合并、版本候选与发布仍是独立门禁。当前不支持 `parent_detached_by_policy`，只有 `detach: forbidden` 可执行。
