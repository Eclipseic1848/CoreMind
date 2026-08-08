# Checkpoints, Diffs, and Restore Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Confirm checkpoint_created before a write.
2. Inspect the actual change with diff.
3. Restore only after an explicit user request.
4. Treat bash and custom tools as non-reversible side effects.
5. Run the listed module tests and `npm run check:modules`.
6. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
