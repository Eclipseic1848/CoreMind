# Sessions and Context Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Enable sessions for continuity and for long tasks that may require context compaction. Disable them only when requests are known to fit without compaction.
2. Use a safe sessionId.
3. Verify restored sessions append only new messages.
4. Verify the context window, output limit, and evidence source for the actual provider/model. Unknown, conflicting, route-mismatched, or output-over-limit capabilities must fail before the provider call.
5. Observe `context_budget_resolved`, `context_compacted`, `context_compaction_failed`, and `context_lifecycle_failed`. Failure must preserve original messages and must not retry the same overflowing request.
6. Confirm summaries preserve goals, constraints, permissions, modified files, test status, and next steps, plus the previous complete turn and the active unfinished user message.
7. Confirm the compaction summary is in the session, the event carries its session-entry reference, and the ledger parent chain validates. At the depth limit, rebuild from canonical session messages.
8. Inject a corrupt session, sessionless compaction, unknown capability, output-limit conflict, artifact drift, model switch, corrupt lineage, and provider overflow. Assert zero or exactly one provider call as the scenario requires.
9. Run the listed module tests and `npm run check:modules`.
10. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
