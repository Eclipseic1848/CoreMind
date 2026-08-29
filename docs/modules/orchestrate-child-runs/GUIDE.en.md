# Child Run Guide

## When to use it

Use a Child Run only when delegated work needs independent model execution, budget, permissions, recovery, and results. Parallel tools, workflow steps, and MCP tool responses do not become Child Runs automatically.

## Integration order

1. Configure finite `maxTokens` and `maxCostUsd` on the parent Runtime.
2. Build a `ChildRunDelegationRequest` no wider than the parent and use a stable DelegationId.
3. The adapter factory must create a real `CoreMindRuntime` with the same `childRunAuthority`, ChildRunId, AbortSignal, task, and canonical cwd.
4. Call `delegateChildRun()`, retain the handle, and call `join()` at the structured join point.
5. Read `RunResult.childRuns`, Protocol v2 query, or TUI `/children`; never read Coordinator internals.

## Results and recovery

Results include outcome, evidence references, artifacts, workspace changes, and unresolved risks. Natural-language summaries are not the only result. A successful result is accepted by default after join. A failed, cancelled, timed-out, or budget-exhausted result must first record a Delegation Disposition that accepts the failure, chooses an alternative, safely redelegates, or propagates the terminal outcome.

Safe redelegation has two steps: first record `redelegate` for the original DelegationId, then create a linked attempt with a new DelegationId, a new budget, and `recoveryOf`. It is allowed only when the RecoveryDisposition proves that no Effect was committed or remains unknown, execution is quiescent, and ownership has been released; this assessment aggregates the current Child and its full descendant tree, so descendant Effects cannot be hidden behind a `delegate` call. If the parent Run forms its own terminal outcome before the successor is created, the Runtime persists `delegation_redelegation_cancelled`, revokes that intent, and makes no further Provider request. For an orphan, unknown Effect, or uncertain ownership, audit processes, tools, leases, and critical facts first. Before any new Provider request, persist `child_orphaned → parent_joined` and wait for human disposition. Never recreate the same delegation automatically. When several siblings await disposition, a human safety gate outranks parent-Agent disposition, every undisposed result outranks terminal propagation, and terminal propagation outranks safe redelegation.

`isExecutionQuiescent()` proves only that every Child has joined and execution resources have settled. `isQuiescent()` additionally requires that no result remains undisposed and no redelegation is waiting for a successor; it matches the Projection's `quiescent` value. Execution quiescence never substitutes for business disposition.

When the parent Run is paused at this gate, Protocol v2 may persist a `delegation_disposition` control as `accepted` while the Runtime is inactive. After `resume`, the rebuilt Child Coordinator validates it and records `applied` or `rejected`. `accepted` does not prove that the business disposition has taken effect.

## Platform note

A Linux sandbox can prove controlled capabilities through its probe. Windows Trusted Host cannot claim sandboxing or controlled egress. Pause and select a verified environment when those capabilities are required.
