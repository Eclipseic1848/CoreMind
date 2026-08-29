# Child Run Failure and Recovery SOP

1. Record ParentRunId, ChildRunId, DelegationId, input fingerprint, and the current fact sequence.
2. Inspect active, paused, orphaned, joined, and lease states through `ProjectionEngine.projectTree()`.
3. After parent cancellation, wait for every child to terminate or pause, flush critical facts, and persist `parent_joined`. Never claim quiescence on timeout.
4. Before orphan recovery, prove that the old worker or process is gone and inspect the workspace lock owner, effect receipts, and checkpoints.
5. Accept a successful result by default only when execution is quiescent, ownership is released, and no Effect is started or unknown. A committed Effect may accompany an accepted success but cannot prove safe redelegation. Persist a Delegation Disposition for every other result.
6. Reuse the original ChildRunId for the same fingerprint and reject conflicting input. Never replay unknown or committed effects by creating another delegation; safe redelegation requires a new DelegationId, a new budget, and `recoveryOf`.
7. Audit a stale lease explicitly through the workspace lease recovery process. Do not remove a lock with a live owner.
8. Run the tests in the module manifest, `npm run check`, and the complete repository gates.

Never bypass Coordinator recovery, swallow cancellation failure, claim unproved controlled networking, treat a projection as recovery authority, or detach without durable Job ownership.
