# Durable Runs and Recovery

Status: contract and documentation aligned with the stable `0.7.1` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

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
- `FileRunStore` provides a single-writer lock, consecutive sequences, per-Fact ordinary append, atomic critical synchronization, and bounded tail repair.
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

## 0.3.1 candidate: correlation invariant checker

`checkInvariantFacts(facts, { mode })` is an internal, read-only Runtime seam. It never modifies facts and does not change the public SDK export surface. Production defaults to `off`; `eval` returns diagnostics; `gate` is used by release acceptance. I-1 through I-12 are stable violation codes, not new public `CoreMindError` codes.

| Violation | Check |
|---|---|
| I-1 | RunState journal sequences are consecutive |
| I-2 | Same-sequence same-content appends are idempotent; different content conflicts |
| I-3 | No record follows `finish` |
| I-4 | New-format StepIds are unique within a Run; legacy 0.3.0 `loop-execute` explicitly degrades |
| I-5 | Run, Session, Turn, and Call correlation is consistent; legacy records without TurnId skip Turn-level checks |
| I-6 | ReceiptId resolves to the same Run, Step, and Call |
| I-7 | Every tool Call has exactly one explainable termination; aborted/timeout Runs explicitly close in-flight Calls |
| I-8 | Checkpoints resolve to the same Run, Operation, Call, and Receipt |
| I-9 | `approval_required` and `approval_resolved` pair one-to-one by ApprovalId |
| I-10 | No late terminal fact bypasses admission after the Abort boundary |
| I-11 | Operation chains start with ACCEPT, keep consecutive sequences, and use legal transitions |
| I-12 | Effect Receipt states move only through legal forward transitions |

## Platform boundary

Windows and Linux use the same contracts and test definitions. A stale lock is not guessed away after a process crash. An operator must first prove that no writer remains, following the [recovery SOP](SOP.en.md). Real cross-process crash behavior still requires target-platform acceptance.

## Source and evidence

- [Operation state machine](../../../packages/coremind-runtime/src/operation-state.ts)
- [RunState](../../../packages/coremind-runtime/src/run-state.ts)
- [Correlation invariant checker](../../../packages/coremind-runtime/src/invariant-checker.ts)
- [Run snapshot](../../../packages/coremind-runtime/src/snapshot.ts)
- [Session adapter](../../../packages/coremind-runtime/src/session.ts)
- [Backend conformance suite](../../../packages/coremind-runtime/src/session-conformance.test.ts)
- [Recovery example](../../../examples/modules/recover-durable-runs/README.en.md)
- [Reusable Skill](../../../skills/recover-durable-runs/SKILL.md)

This module verifies framework recovery contracts. It does not replace idempotency and compensation in payment, database, or other external business systems.
