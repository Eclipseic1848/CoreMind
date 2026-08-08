# Trace, RunState, and Debugging

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Preserve reviewable evidence through events carrying runId, eventId, sequence, and timestamp plus append-only RunState, and derive safe resume plans.

## Public interfaces

- `TraceRecorder`
- `RunStateJournal`
- `FileRunStore`
- `CoreMindEvent`
- `prepareRunResume`

## Errors and boundaries

- Corrupt or discontinuous JSONL reports run_state_corrupt
- Finished runs cannot be resumed again
- Resume is rejected for mismatched config fingerprints, input, or non-replay-safe side effects
- Events increase monotonically and include approvals, budgets, and checkpoints in one trace

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/trace.ts](../../../packages/coremind-runtime/src/trace.ts)
- [packages/coremind-runtime/src/run-state.ts](../../../packages/coremind-runtime/src/run-state.ts)
- [packages/coremind-runtime/src/events.ts](../../../packages/coremind-runtime/src/events.ts)
- [packages/coremind-runtime/src/run-state.test.ts](../../../packages/coremind-runtime/src/run-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)
- [Module example](../../../examples/modules/inspect-agent-traces/README.en.md)
- [Agent Skill](../../../skills/inspect-agent-traces/SKILL.md)
