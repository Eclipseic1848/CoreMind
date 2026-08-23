# 长程上下文必须从权威事实生成模型工作集

CoreMind 已在每次 Provider 请求前执行确定性压缩，并把压缩产物关联到 Session 事实；但不同模型窗口、自定义端点能力、反复压缩和长任务 Resume 仍可能让“自动压缩”被误解为无限上下文。本决策声明：每次请求都为即将调用的具体模型解析 Context Capability，并从权威 Fact 构建 Context Working Set；模型切换时按新预算重建，压缩必须保留 lineage，无法安全容纳时以 `context_budget_exhausted` 暂停而不是静默截断。

## Status

accepted（2026-08-22 用户确认）

## Considered Options

- **超过窗口时删除最旧消息**：被否。无法证明目标、权限、未决审批、未知副作用和活动计划未被删除，也无法重建实际请求。
- **持续对上一版摘要再摘要**：被否。摘要误差会逐代累积，模型切换后也无法证明旧摘要适配新窗口。
- **Fact → TaskState Projection → Working Set**（采纳）：完整历史留在事实域，稳定任务状态与压缩 lineage 可重建，本次 Provider 只消费满足具体模型预算的工作集。

## Consequences

- Context Window、最大输出、稳定前缀、工具 Schema、协议开销和安全余量共同决定可发送输入预算。
- 核心规则、当前目标、显式约束、审批、未知副作用、活动计划和最小最近完整轮次属于不可静默删除集合。
- 多次压缩达到链深阈值后，必须从 canonical facts 重新投影基线摘要，不能只压缩摘要。
- Provider 报告超窗后不得盲目重试原请求；应记录能力冲突、重新解析预算并重建工作集。
- 详细合同与验收见 [0.3.x-C 长程上下文规格](../spec/0.3.x-c/01-long-horizon-context-lifecycle.md)和[验收矩阵](../spec/0.3.x-c/03-acceptance-matrix.md)。
