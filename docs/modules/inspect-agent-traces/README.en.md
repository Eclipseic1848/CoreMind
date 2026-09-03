# Trace, RunState, and Debugging

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Preserve reviewable evidence through redacted ordered events and append-only RunState, including stable Loop snapshots, effect receipts, Context working-set fingerprints, and Provider-request fingerprints. Derive safe resume plans, local observations, and deterministic offline replay from the same Fact Projection.

## Public interfaces

- `TraceRecorder`
- `RunStateJournal`
- `FileRunStore`
- `CoreMindEvent`
- `prepareRunResume`
- `LoopControllerSnapshot`
- `projectLocalObservability`
- `ReplayKit`
- `TelemetryEgressController`

## Errors and boundaries

- Corrupt or discontinuous JSONL reports run_state_corrupt
- Finished runs cannot be resumed again
- Resume is rejected for mismatched configuration fingerprints, input, or unknown effects
- Events increase monotonically and include Loop states, approvals, budgets, effect receipts, and checkpoints in one trace
- Credential fields, bodies, command secrets, and URL secrets are redacted before Trace/RunState persistence while paths and non-sensitive test commands remain auditable
- `ReplayKit` consumes only fixed Facts and actual Provider Working Set fixtures; it calls neither Providers nor tools and reports `run_state_corrupt` when a fixture does not match persisted request fingerprints
- Local observation is always explicit and Telemetry defaults to `DISABLED`. Process-external delivery requires a persisted configuration, user consent, and an exact-origin egress receipt from a trusted Adapter
- Core validates receipt fields for origin, resolved addresses, redirect/proxy deny, strict TLS, and fingerprinting. It cannot prove that the Adapter actually enforced DNS, TLS, or network policy, and `handed_off` does not mean receiver-side delivery

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/trace.ts](../../../packages/coremind-runtime/src/trace.ts)
- [packages/coremind-runtime/src/run-state.ts](../../../packages/coremind-runtime/src/run-state.ts)
- [packages/coremind-runtime/src/events.ts](../../../packages/coremind-runtime/src/events.ts)
- [packages/coremind-runtime/src/observability.ts](../../../packages/coremind-runtime/src/observability.ts)
- [packages/coremind-runtime/src/replay-kit.ts](../../../packages/coremind-runtime/src/replay-kit.ts)
- [packages/coremind-runtime/src/run-state.test.ts](../../../packages/coremind-runtime/src/run-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [packages/coremind-runtime/src/trace.test.ts](../../../packages/coremind-runtime/src/trace.test.ts)
- [packages/coremind-runtime/src/observability.test.ts](../../../packages/coremind-runtime/src/observability.test.ts)
- [packages/coremind-runtime/src/replay-kit.test.ts](../../../packages/coremind-runtime/src/replay-kit.test.ts)
- [packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx](../../../packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx)
- [模块示例](../../../examples/modules/inspect-agent-traces/README.zh-CN.md)
- [Module example](../../../examples/modules/inspect-agent-traces/README.en.md)
- [Agent Skill](../../../skills/inspect-agent-traces/SKILL.md)
