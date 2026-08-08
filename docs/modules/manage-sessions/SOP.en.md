# Sessions and Context Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Enable sessions only when continuity is required.
2. Use a safe sessionId.
3. Verify restored sessions append only new messages.
4. Observe context_compacted events.
5. Inject a corrupt-file failure.
6. Run the listed module tests and `npm run check:modules`.
7. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
