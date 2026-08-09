# Permissions and Security Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Start with ask by default.
2. List allowed and denied tools.
3. Choose ask, allow, or deny for network tools while noting that Linux bash remains offline.
4. Review every custom tool `effect`, then test nested paths, URLs, absolute paths, drives, UNC paths, and directory links against recursive and canonical checks.
5. Verify all three modes with real tools, not only mocks.
6. Never interpret full as disabling deny, workspace, network, audit, or checkpoints.
7. Windows constrained shell must fail closed. Host-shell access requires the user to select full mode, disable workspace restriction, allow network, and accept that no OS isolation exists. An isolated Linux environment remains an alternative.
8. Run the listed module tests and `npm run check:modules`.
9. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
