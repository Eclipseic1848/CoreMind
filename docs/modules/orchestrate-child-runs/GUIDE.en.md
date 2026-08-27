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

Results include outcome, evidence references, artifacts, workspace changes, and unresolved risks. Natural-language summaries are not the only result. For an orphan, audit processes, tools, leases, and critical facts before any resume decision. Never recreate the same delegation automatically.

## Platform note

A Linux sandbox can prove controlled capabilities through its probe. Windows Trusted Host cannot claim sandboxing or controlled egress. Pause and select a verified environment when those capabilities are required.
