# 测试、评测与质量门禁

状态：合同与文档已对齐 `0.7.1` 稳定版发布线；支持平台：Windows、Linux。macOS 尚未列为正式支持。

## 目的

分离运行成功、指标、业务评测和发布判断，并用可重复场景阻止失败伪装成通过。

## 公共接口

- `checkProject`
- `runEvaluationSuite`
- `EvaluationGrader` 与七类具体 grader
- `RunOutcome`
- `EvaluationReport`
- `ReleaseReadiness`
- `defineExperiment`、`selectExperimentArm` 与 `runExperiment`
- `ExperimentRecord`

## 错误与边界

- 安全门禁不可覆盖
- 非安全门禁只有在 allowOverride 和明确原因同时存在时才能覆盖，并追加写入 .coremind/quality-overrides.jsonl
- 审计写入失败时拒绝覆盖
- strict 场景至少重复三次
- schemaVersion 2 必须至少包含一个 `outcome` grader；同一场景最多 20 个 grader
- 命令、文件和差异评测都有工作区、输出与超时上限；既有脏工作区默认必须保持原样
- 实验 arm 由实验 id、版本、seed 与输入指纹确定性分配；同一输入可复现，不伪装成密码学随机
- 每条实验记录必须绑定版本、环境、输入指纹、arm、运行终态、完整 Trace 和 grader 结果

CoreMind 只提供机制、质量护栏和开发指导。业务目标、规则、数据字段、审批责任和最终验收由用户或业务负责人决定。

## 源码、测试与示例

- [packages/coremind-runtime/src/evaluation.ts](../../../packages/coremind-runtime/src/evaluation.ts)
- [packages/coremind-runtime/src/evaluation-graders.ts](../../../packages/coremind-runtime/src/evaluation-graders.ts)
- [packages/coremind-runtime/src/project-check.ts](../../../packages/coremind-runtime/src/project-check.ts)
- [packages/coremind-runtime/src/result.ts](../../../packages/coremind-runtime/src/result.ts)
- [packages/coremind-runtime/src/experiment.ts](../../../packages/coremind-runtime/src/experiment.ts)
- [packages/coremind-runtime/src/evaluation.test.ts](../../../packages/coremind-runtime/src/evaluation.test.ts)
- [packages/coremind-runtime/src/batch8-properties.test.ts](../../../packages/coremind-runtime/src/batch8-properties.test.ts)
- [packages/coremind-runtime/src/project-check.test.ts](../../../packages/coremind-runtime/src/project-check.test.ts)
- [packages/coremind-runtime/src/quality.test.ts](../../../packages/coremind-runtime/src/quality.test.ts)
- [packages/coremind-runtime/src/experiment.test.ts](../../../packages/coremind-runtime/src/experiment.test.ts)
- [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)
- [Module example](../../../examples/modules/evaluate-agents/README.en.md)
- [Agent Skill](../../../skills/evaluate-agents/SKILL.md)
- [TypeScript/Python 真实缺陷评测](../../../examples/coding-evals/README.zh-CN.md)
