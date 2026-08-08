# Permissions and Security Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Start with ask by default.
2. List allowed and denied tools.
3. Choose ask, allow, or deny for network tools while noting that Linux bash remains offline.
4. Verify all three modes with real tools.
5. Never interpret full as disabling audit or checkpoints.
6. Treat Windows shell execution as a non-reversible high-risk operation because it has no OS sandbox.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
