# Orchestrate Child Runs

Status: unreleased `0.7.x` source candidate for Windows and Linux. This is not a capability of the current public stable `0.3.1` release.

A Child Run is a complete Run delegated by a parent Run, not an ordinary tool call. It owns an independent RunId, facts, budget, permissions, result, and quiescence state, linked through ParentRunId, ChildRunId, and DelegationId.

## Implemented contract

- The same DelegationId and input fingerprint is idempotent; conflicting input fails closed.
- Model, canonical workspace, context references, permissions, tools, paths, credentials, environment, and multidimensional budgets can only stay equal or narrow.
- Finite defaults are depth 3, four active children, and 32 total descendants; infinite or negative limits are rejected.
- Parent cancellation propagates and joins children. Child cancellation does not cancel the parent. Join timeout cancels and waits for cleanup.
- A restored child with uncertain ownership persists `child_orphaned → parent_joined` before any new Provider request, enters a human orphan-audit pause, and is not restarted automatically.
- A successful join is accepted by default only when execution is quiescent, ownership is released, and no Effect is started or unknown. A committed Effect may accompany an accepted success but does not prove safe redelegation. Every other terminal outcome or anomalous success with unresolved risk requires a recorded disposition before the parent can continue or finish.
- Redelegation requires a safe RecoveryDisposition plus a linked new DelegationId and a new budget. The same identity is never rerun automatically.
- If the parent forms its own terminal outcome before successor creation, it persistently revokes the pending redelegation and makes no further Provider request.
- A paused Run may persist an offline human Disposition control, which takes effect only after resume rebuilds the Coordinator.
- One lifecycle reducer validates paused, terminal, orphaned, and joined facts and rejects state regression.
- `ProjectionEngine.projectTree()` rebuilds the tree, results, and actual workspace lease events from canonical parent and child facts.
- Protocol v2, Worker, TypeScript `RunResult`, CLI JSONL, and TUI `/children` share that projection.

## Security boundary

The Runtime verifies the parent policy against the actual provider/model, canonical cwd, permissions, tools, environment probe, and runtime budget. A real Child Runtime must bind the same delegation object, RunId, AbortSignal, and task before execution. Windows Trusted Host cannot prove sandboxing or controlled egress, so such requirements fail closed.

Durable detach is not supported. `detach: forbidden` is the only executable policy until durable Job ownership transfer and recovery evidence exist.

## Evidence

- [Child Run module](../../../packages/coremind-runtime/src/child-run.ts)
- [Runtime adapter](../../../packages/coremind-runtime/src/child-runtime-adapter.ts)
- [ADR 0008](../../adr/0008-subagents-as-child-runs.md)
- [0.7.x specification](../../spec/0.7.x/01-child-run-contract.md)
- [Guide](GUIDE.en.md)
- [SOP](SOP.en.md)
- [Example](../../../examples/modules/orchestrate-child-runs/README.en.md)

Offline tests and local Runtime evidence do not replace real multi-agent product acceptance, cross-process crash drills, remote CI, real-provider certification, or release authorization.
