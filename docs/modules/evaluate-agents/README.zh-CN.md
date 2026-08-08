# 测试、评测与质量门禁

状态：implemented-alpha；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。

## 公共接口

- `checkProject`
- `runEvaluationSuite`
- `RunOutcome`
- `EvaluationReport`
- `ReleaseReadiness`

## 错误与边界

- 安全门禁不可覆盖
- 非安全门禁只有在 allowOverride 和明确原因同时存在时才能覆盖，并追加写入 .coremind/quality-overrides.jsonl
- 审计写入失败时拒绝覆盖
- strict 场景至少重复三次

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/evaluation.ts](../../../packages/coremind-runtime/src/evaluation.ts)
- [packages/coremind-runtime/src/project-check.ts](../../../packages/coremind-runtime/src/project-check.ts)
- [packages/coremind-runtime/src/result.ts](../../../packages/coremind-runtime/src/result.ts)
- [packages/coremind-runtime/src/evaluation.test.ts](../../../packages/coremind-runtime/src/evaluation.test.ts)
- [packages/coremind-runtime/src/project-check.test.ts](../../../packages/coremind-runtime/src/project-check.test.ts)
- [packages/coremind-runtime/src/quality.test.ts](../../../packages/coremind-runtime/src/quality.test.ts)
- [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)
- [Module example](../../../examples/modules/evaluate-agents/README.en.md)
- [Agent Skill](../../../skills/evaluate-agents/SKILL.md)
