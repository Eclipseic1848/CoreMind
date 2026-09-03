# Subagent 统一建模为 Child Run

把 Subagent 当作普通 Tool Call 会隐藏其模型请求、预算、权限、Workspace 写入、取消和 RecoveryDecision，使父任务无法解释委派是否安全收敛。本决策声明：Subagent 在 Runtime 内统一建模为 Child Run，拥有独立身份、事实、预算、权限、终态和 RecoveryDecision，并通过类型化父子关系连接父 Run；产品界面可以把它投影为简洁委派。

## Status

accepted；已进入 `v0.7.0` Tag，公开发布待完成

## Considered Options

- **普通 Tool Call**：被否。只能表达一次调用和结果，无法独立 Resume、检查预算、传播取消或证明 Workspace 冲突已收敛。
- **共享父 Run 状态的后台 Agent**：被否。事实、权限和终态相互污染，崩溃后无法判定所有权与孤儿活动。
- **Child Run**（采纳）：复用 Run 的事实与控制合同，通过 ParentRunId/ChildRunId 关联；UI 是否展开详情只是 Projection 选择。

## Consequences

- Child Run 的权限、预算和 Execution Environment 只能维持或收紧父级限制，不能自行扩大。
- 父子取消、等待、超时、孤儿回收和 Quiescent 必须有类型化事实；父 Run 不能在仍有未处置 Child Run 时宣称静止。
- Child Run 写 Workspace 时必须取得同一 Workspace Lease；父子关系不授予并行写特权。
- Child Run 的 EffectReceipt 独立归属自己的 Run；父 Run 只保存委派关联与结果引用，不复制或重放子级 Effect。
- 详细合同见 [0.7.x Child Run 规格](../spec/0.7.x/01-child-run-contract.md)。
