# Agent 构建

状态：已发布的 `0.3.0` 稳定版；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

把聚焦的系统提示、模型选项、工具和技能构造成独立 Agent 实例。

## 公共接口

- `buildAgent`
- `CoreMindRuntime.create`
- `buildAgentFromConfig`

## 错误与边界

- unknown_agent：指定 Agent 不存在
- agent_failed：上游 stopReason:error 或模型失败

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/agent-factory.ts](../../../packages/coremind-runtime/src/agent-factory.ts)
- [packages/coremind-runtime/src/runtime.ts](../../../packages/coremind-runtime/src/runtime.ts)
- [packages/coremind-runtime/src/agent-factory.test.ts](../../../packages/coremind-runtime/src/agent-factory.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/design-agents/README.zh-CN.md)
- [Module example](../../../examples/modules/design-agents/README.en.md)
- [Agent Skill](../../../skills/design-agents/SKILL.md)
