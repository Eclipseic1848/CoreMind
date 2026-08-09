# Sessions and Context Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Enable sessions only when continuity is required.
2. Use a safe sessionId.
3. Verify restored sessions append only new messages.
4. Observe context_compacted and context_compaction_failed events; a failure must preserve original messages.
5. Confirm summaries preserve goals, constraints, permissions, modified files, test status, and next steps.
6. Inject corrupt-file and compaction failures.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
