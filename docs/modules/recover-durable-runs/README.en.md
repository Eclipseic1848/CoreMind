# Durable Runs and Recovery

Status: unpublished `0.3.0` stable candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

This module gives every agent run a recoverable and auditable envelope without claiming false success. It does not duplicate Workflow or Loop phases. A durable operation only states whether work is accepted, running, paused, aborting, completed, or failed.

## One owner for each state class

| State | Authoritative owner | Not responsible for |
|---|---|---|
| Conversation and compacted view | Session | Deciding whether a run completed |
| Run lifecycle and trace | DurableOperation + RunState | Storing complete large tool output |
| File and external effects | Checkpoint + Effect Receipt | Replacing the business system transaction log |
| Tokens, cost, and limits | RunBudget + RunMetrics | Inventing data omitted by a provider |

LoopController remains the owner of planning, execution, verification, and repair. No parallel Loop is introduced.

## Stable contracts

- `RunResult.operation` is the authoritative operation snapshot shared by CLI, TUI, TypeScript, and Python.
- `RunResult.snapshot` is the shared pure-JSON terminal envelope for operation, outcome, metrics, evaluation, trace, checkpoints, artifacts, extension receipts, and resumability.
- `DurableOperation` validates transitions, duplicate events, and restoration.
- `FileRunStore` provides a single-writer lock, consecutive sequences, atomic publication, and bounded tail repair.
- `prepareRunResume()` checks the configuration fingerprint, terminal state, stable steps, and effect receipts.
- `CoreMindSession` preserves a stable public path, backend conformance, and versioned migration.

## Invariants

- Only legal operation transitions are accepted, and terminal states cannot resume.
- Reusing an `eventId` does not apply a transition twice.
- A committed effect is skipped only with its stable completed step; uncertainty requires human review.
- Checkpoints, tool calls, and effect receipts share one idempotency correlation key.
- RunState records must be consecutive in actual persisted order. Read and resume never sort away an ordering fault, and competing writers never overwrite silently.
- Approval or policy denial before execution records `not_started`, which is safe to reconsider; `started` is emitted only after execution is authorized to begin.
- Only an incomplete final JSONL line after complete records may be repaired; whole-file corruption fails closed.
- A legacy Session gets a `.v3.backup` before migration, and its public source remains unchanged on failure.

## Platform boundary

Windows and Linux use the same contracts and test definitions. A stale lock is not guessed away after a process crash. An operator must first prove that no writer remains, following the [recovery SOP](SOP.en.md). Real cross-process crash behavior still requires target-platform acceptance.

## Source and evidence

- [Operation state machine](../../../packages/coremind-runtime/src/operation-state.ts)
- [RunState](../../../packages/coremind-runtime/src/run-state.ts)
- [Run snapshot](../../../packages/coremind-runtime/src/snapshot.ts)
- [Session adapter](../../../packages/coremind-runtime/src/session.ts)
- [Backend conformance suite](../../../packages/coremind-runtime/src/session-conformance.test.ts)
- [Recovery example](../../../examples/modules/recover-durable-runs/README.en.md)
- [Reusable Skill](../../../skills/recover-durable-runs/SKILL.md)

This module verifies framework recovery contracts. It does not replace idempotency and compensation in payment, database, or other external business systems.
