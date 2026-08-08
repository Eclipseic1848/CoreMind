# Provider 与模型

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

继承锁定运行时依赖的 Provider 清单，并把“可选”与“经过真实认证”严格分开。

## 公共接口

- `buildProviderRuntime`
- `listInheritedProviders`

## 错误与边界

- 未知 Provider 或模型会拒绝启动
- 缺少 apiKeyEnv 时会给出明确鉴权错误

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/provider.ts](../../../packages/coremind-runtime/src/provider.ts)
- [packages/coremind-runtime/src/provider.test.ts](../../../packages/coremind-runtime/src/provider.test.ts)
- [packages/coremind-runtime/src/integration.real.test.ts](../../../packages/coremind-runtime/src/integration.real.test.ts)
- [模块示例](../../../examples/modules/manage-providers/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-providers/README.en.md)
- [Agent Skill](../../../skills/manage-providers/SKILL.md)
