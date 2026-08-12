# Trace, RunState, and Debugging

Status: `0.3.0-rc.2` release candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Preserve reviewable evidence through redacted ordered events and append-only RunState, including stable Loop snapshots and effect receipts, then derive safe resume plans.

## Public interfaces

- `TraceRecorder`
- `RunStateJournal`
- `FileRunStore`
- `CoreMindEvent`
- `prepareRunResume`
- `LoopControllerSnapshot`

## Errors and boundaries

- Corrupt or discontinuous JSONL reports run_state_corrupt
- Finished runs cannot be resumed again
- Resume is rejected for mismatched configuration fingerprints, input, or unknown effects
- Events increase monotonically and include Loop states, approvals, budgets, effect receipts, and checkpoints in one trace
- Credential fields, bodies, command secrets, and URL secrets are redacted before Trace/RunState persistence while paths and non-sensitive test commands remain auditable

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/trace.ts](../../../packages/coremind-runtime/src/trace.ts)
- [packages/coremind-runtime/src/run-state.ts](../../../packages/coremind-runtime/src/run-state.ts)
- [packages/coremind-runtime/src/events.ts](../../../packages/coremind-runtime/src/events.ts)
- [packages/coremind-runtime/src/run-state.test.ts](../../../packages/coremind-runtime/src/run-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [packages/coremind-runtime/src/trace.test.ts](../../../packages/coremind-runtime/src/trace.test.ts)
- [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)
- [Module example](../../../examples/modules/inspect-agent-traces/README.en.md)
- [Agent Skill](../../../skills/inspect-agent-traces/SKILL.md)
