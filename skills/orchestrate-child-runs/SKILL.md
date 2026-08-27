---
name: orchestrate-child-runs
description: "Design, implement, diagnose, or verify CoreMind Child Runs with durable identity, monotonic authority, structured concurrency, orphan audit, workspace leases, and shared projections."
---

# Orchestrate Child Runs

1. Read the [module contract](../../docs/modules/orchestrate-child-runs/README.en.md), ADR 0008, and the 0.7.x specification.
2. Model delegated agents as complete Child Runs, never as ordinary tool calls or background promises sharing parent state.
3. Freeze ParentRunId, ChildRunId, DelegationId, input fingerprint, bounded context references, policy snapshot, and workspace identity before execution.
4. Derive authority from the actual Runtime. Require finite parent token and cost limits, reserve parent budget, and never widen model, permission, tool, path, credential, network, or environment scope.
5. Use a real `CoreMindRuntime` adapter and verify the same authority object, RunId, AbortSignal, task, canonical cwd, and quiescence before accepting a result.
6. Propagate parent cancellation, join every handled child, and fail closed if cleanup or critical Fact flush cannot reach quiescence.
7. On restore, audit uncertain ownership and workspace leases before resume. Never restart an orphan automatically.
8. Read Child Run state only through `ProjectionEngine.projectTree()`, `RunResult.childRuns`, Protocol v2, or TUI `/children`.
9. Run the 1,000-seed interleaving matrix, adapter and Runtime tests, workspace lease tests, Worker parity, CLI/TUI tests, then repository gates.
10. Do not claim durable detach, sandboxing, controlled egress, real-provider certification, cross-process crash acceptance, or release status without matching evidence.

中文原则：子级是独立 Run；权威只能收紧，取消必须收敛，孤儿必须先审计，投影不能代替事实。
