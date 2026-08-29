# Child Run 使用指南

## 何时使用

只有子任务需要独立模型执行、预算、权限、恢复与结果时才使用 Child Run。普通并行工具、Workflow Step 和 MCP Tool 返回不应自动升级为 Child Run。

## 接入顺序

1. 为父 Runtime 配置有限的 `maxTokens` 与 `maxCostUsd`。
2. 构造不宽于父级的 `ChildRunDelegationRequest`，使用稳定 DelegationId。
3. Adapter 工厂创建真实 `CoreMindRuntime` 时必须传入相同 `childRunAuthority`、ChildRunId、AbortSignal、task 和 canonical cwd。
4. 调用 `delegateChildRun()`，保存 Handle，并在结构化 join 点调用 `join()`。
5. 读取 `RunResult.childRuns`、Protocol v2 query 或 TUI `/children`，不要读取 Coordinator 内部 Map。

## 结果与恢复

结果包含 outcome、证据引用、Artifact、Workspace changes 和未决风险。自然语言摘要不是唯一结果。成功结果只有在执行静止、所有权释放且没有 started/unknown Effect 时才在 join 后默认接受；已完成的 committed Effect 可以随成功结果接受，但不能证明可安全重新委派。失败、取消、超时、预算耗尽或带未决风险的异常成功结果必须先记录 Delegation Disposition，选择接受风险、改走其他方案、安全重新委派或传播终态。

安全重新委派分两步：先为原 DelegationId 记录 `redelegate`，再用新的 DelegationId、新预算和 `recoveryOf` 建立关联尝试。只有 RecoveryDisposition 证明没有已提交或未知 Effect、执行已静止且所有权释放时才允许；该评估聚合当前 Child 及其完整后代树，不能把后代 Effect 隐藏在一次 `delegate` 调用后。若父 Run 在 successor 创建前形成自身终态，Runtime 会持久化 `delegation_redelegation_cancelled` 并撤销该意图，不得再请求 Provider。恢复遇到 orphan、未知 Effect 或所有权不明时先审计实际进程、工具、Lease 和关键 Fact，并在任何新 Provider 请求前持久化 `child_orphaned → parent_joined` 后等待人工处置；不得自动重新执行同一委派。多个 sibling 同时等待处置时，人工安全门优先于父 Agent 处置，任何未处置项优先于传播终态，传播终态优先于安全重新委派。

`isExecutionQuiescent()` 只证明所有 Child 已 join 且执行资源已收敛；`isQuiescent()` 还要求没有未处置结果或待建立 successor 的重新委派，并与 Projection 的 `quiescent` 保持一致。执行静止不能替代业务处置。

父 Run 已因该门暂停时，Protocol v2 的 `delegation_disposition` 控制可以在 Runtime 不活动时先持久为 `accepted`；调用 `resume` 后由重建的 Child Coordinator 校验并写入 `applied` 或 `rejected`。`accepted` 不是业务处置已生效的证明。

## 平台说明

Linux sandbox 可通过探针证明受控能力。Windows Trusted Host 只提供受信任宿主能力，不能宣称 sandbox 或 controlled egress。需要这些能力时应暂停并更换已验证执行环境。
