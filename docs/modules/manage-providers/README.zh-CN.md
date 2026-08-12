# Provider 与模型

状态：`0.3.0-rc.2` 发布候选；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

继承锁定运行时依赖的 Provider 清单，并把“可选”与“经过真实认证”严格分开。

## 公共接口

- `buildProviderRuntime`
- `listInheritedProviders`
- `listSupportedProviders`
- `coremind providers`

## 错误与边界

- 未知 Provider 或模型会拒绝启动
- 缺少 apiKeyEnv 时会给出明确鉴权错误
- Runtime 只从调用方注入的环境读取凭据；显式配置 `apiKeyEnv` 后，该变量是唯一密钥来源，不会回退到宿主进程、凭据文件或 Provider 默认变量
- 目录可识别只代表“可配置”；当前认证必须同时覆盖流式、工具、结构化结果、多轮、中止、错误映射和长上下文
- 旧证据缺少当前检查时保留缺口，但自动降级为“可配置、未完成当前认证”
- 当前版本认证必须保存完整 Git commit 与 Runtime Artifact SHA-256；证据只能绑定已实际测试的构建

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/provider.ts](../../../packages/coremind-runtime/src/provider.ts)
- [packages/coremind-runtime/src/provider.test.ts](../../../packages/coremind-runtime/src/provider.test.ts)
- [packages/coremind-runtime/src/integration.real.test.ts](../../../packages/coremind-runtime/src/integration.real.test.ts)
- [认证 SOP](../../providers/CERTIFICATION.zh-CN.md)
- [模块示例](../../../examples/modules/manage-providers/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-providers/README.en.md)
- [Agent Skill](../../../skills/manage-providers/SKILL.md)
