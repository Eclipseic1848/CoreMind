# Workflows and Bounded Loops

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Compose agents with sequence, parallelism, conditions, and bounded retries, enforce a global loop budget, and resume safely from persisted stable step boundaries.

## Public interfaces

- `Orchestrator`
- `evalCondition`
- `RunBudgetController`
- `prepareRunResume`
- `fingerprintRunConfig`

## Errors and boundaries

- Step timeout, unknown agent, exhausted retries, and step-budget overflow fail explicitly
- Parallel steps use isolated agent instances
- Automatic resume fails with unsafe_resume when an incomplete step called a non-replay-safe tool

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/orchestrator.ts](../../../packages/coremind-runtime/src/orchestrator.ts)
- [packages/coremind-config/src/schema/workflow.ts](../../../packages/coremind-config/src/schema/workflow.ts)
- [packages/coremind-runtime/src/orchestrator.test.ts](../../../packages/coremind-runtime/src/orchestrator.test.ts)
- [packages/coremind-runtime/src/budget.test.ts](../../../packages/coremind-runtime/src/budget.test.ts)
- [模块示例](../../../examples/modules/design-workflows/README.zh-CN.md)
- [Module example](../../../examples/modules/design-workflows/README.en.md)
- [Agent Skill](../../../skills/design-workflows/SKILL.md)
