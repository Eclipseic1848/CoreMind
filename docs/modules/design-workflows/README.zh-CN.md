# Workflow 与受控 Loop

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

用顺序、并行、条件和有限重试组合 Agent，以全局预算阻止无边界循环，并从已持久化的稳定步骤边界安全恢复。

## 公共接口

- `Orchestrator`
- `evalCondition`
- `RunBudgetController`
- `prepareRunResume`
- `fingerprintRunConfig`

## 错误与边界

- 步骤超时、未知 Agent、重试耗尽和总步骤超限均明确失败
- 并发步骤使用独立 Agent 实例
- 未完成步骤调用过非重放安全工具时以 unsafe_resume 拒绝自动恢复

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/orchestrator.ts](../../../packages/coremind-runtime/src/orchestrator.ts)
- [packages/coremind-config/src/schema/workflow.ts](../../../packages/coremind-config/src/schema/workflow.ts)
- [packages/coremind-runtime/src/orchestrator.test.ts](../../../packages/coremind-runtime/src/orchestrator.test.ts)
- [packages/coremind-runtime/src/budget.test.ts](../../../packages/coremind-runtime/src/budget.test.ts)
- [模块示例](../../../examples/modules/design-workflows/README.zh-CN.md)
- [Module example](../../../examples/modules/design-workflows/README.en.md)
- [Agent Skill](../../../skills/design-workflows/SKILL.md)
