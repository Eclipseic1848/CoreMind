# Testing, Evaluation, and Quality Gates

Status: unpublished `0.3.0` stable candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes.

## Public interfaces

- `checkProject`
- `runEvaluationSuite`
- `EvaluationGrader` and the seven concrete grader types
- `RunOutcome`
- `EvaluationReport`
- `ReleaseReadiness`
- `defineExperiment`, `selectExperimentArm`, and `runExperiment`
- `ExperimentRecord`

## Errors and boundaries

- Security gates cannot be overridden
- Non-security gates require allowOverride plus an explicit reason and append a record to .coremind/quality-overrides.jsonl
- An audit-write failure rejects the override
- Strict scenarios run at least three times
- schemaVersion 2 requires at least one `outcome` grader and allows at most 20 graders per scenario
- Command, file, and diff evaluation enforce workspace, output, and timeout limits; pre-existing dirty-worktree content is preserved by default
- Arm assignment is deterministic from experiment id, version, seed, and input fingerprint; it is reproducible and is not presented as cryptographic randomness
- Every experiment record binds version, environment, input fingerprint, arm, terminal outcome, complete trace, and grader results

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

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
- [TypeScript/Python real-defect evaluations](../../../examples/coding-evals/README.en.md)
