# TypeScript SDK

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

通过 coremind-ai 单一门面在 Node 工程中嵌入 Runtime、工具、会话、评测和事件。

## 公共接口

- `CoreMindRuntime`
- `ChatSession`
- `defineTool`
- `checkProject`
- `runEvaluationSuite`

## 错误与边界

- 公共错误使用 CoreMindError.code
- 库门面只 re-export，不复制业务逻辑

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind/src/index.ts](../../../packages/coremind/src/index.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-typescript/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-typescript/SKILL.md)
