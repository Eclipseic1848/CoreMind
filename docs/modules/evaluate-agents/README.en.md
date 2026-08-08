# Testing, Evaluation, and Quality Gates

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes.

## Public interfaces

- `checkProject`
- `runEvaluationSuite`
- `RunOutcome`
- `EvaluationReport`
- `ReleaseReadiness`

## Errors and boundaries

- Security gates cannot be overridden
- Non-security gates require allowOverride plus an explicit reason and append a record to .coremind/quality-overrides.jsonl
- An audit-write failure rejects the override
- Strict scenarios run at least three times

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/evaluation.ts](../../../packages/coremind-runtime/src/evaluation.ts)
- [packages/coremind-runtime/src/project-check.ts](../../../packages/coremind-runtime/src/project-check.ts)
- [packages/coremind-runtime/src/result.ts](../../../packages/coremind-runtime/src/result.ts)
- [packages/coremind-runtime/src/evaluation.test.ts](../../../packages/coremind-runtime/src/evaluation.test.ts)
- [packages/coremind-runtime/src/project-check.test.ts](../../../packages/coremind-runtime/src/project-check.test.ts)
- [packages/coremind-runtime/src/quality.test.ts](../../../packages/coremind-runtime/src/quality.test.ts)
- [模块示例](../../../examples/modules/evaluate-agents/README.zh-CN.md)
- [Module example](../../../examples/modules/evaluate-agents/README.en.md)
- [Agent Skill](../../../skills/evaluate-agents/SKILL.md)
