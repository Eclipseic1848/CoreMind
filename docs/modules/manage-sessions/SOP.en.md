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

## Session tree acceptance (1.4 release line)

1. Compare actual local fake-provider payloads across branch selection, independent process restart and fork. Source bytes must stay unchanged by fork.
2. Reject active Runs, competing writers, stale history, unknown/foreign nodes and invalid names/paths before writes or requests. New-session tools still need fresh Run approval, without inherited controls or execution records.
3. Inject selection failures before write, at a torn tail, after durable write, and at fork alias publication. Preserve evidence and reopen to determine facts; do not blindly rerun.
4. Run chat-session-tree and session-navigation-fault tests plus original module regressions; execute `node examples/modules/manage-sessions/branches.mjs`. Check additive APIs, generated Worker/error contracts and original gates.
5. Stop writers and preserve all fact domains before older SDK rollback; restore pre-upgrade backups instead of letting an older writer ignore the selection and continue main.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.

Unpublished source fix: end-of-run session summaries consume the same Run turn/token/cost budget and remaining deadline, and obey cancellation. Insufficient budget skips compaction while preserving history. Compare actual provider calls with persisted request facts; unknown usage on failure is not zero usage.

## Cross-language acceptance

Protocol v2 and sync/async Python task/session methods use the same Node Runtime. See the [cross-language guide](../embed-coremind-python/GUIDE.en.md). Run `python -X utf8 examples/modules/embed-coremind-python/tasks.py` and `python -X utf8 -W error::ResourceWarning -m unittest discover -s python/tests -p test_session_management.py -v`. Verify real restart, committed calls, session identity, cancellation and errors; mocks or process liveness alone are insufficient.
