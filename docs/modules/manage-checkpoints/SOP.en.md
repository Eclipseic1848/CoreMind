# Checkpoints, Diffs, and Restore Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Confirm checkpoint_created before a write.
2. After the tool completes, confirm the checkpoint has its expected post-tool state, then inspect the actual change with diff.
3. Restore only after an explicit user request and a fresh check that no later user or concurrent edit exists.
4. Stop automatic restore on `checkpoint_conflict`, preserve the current file, and perform a manual three-way comparison.
5. Treat bash and custom tools without proven recovery as non-reversible side effects.
6. Run the listed module tests and `npm run check:modules`.
7. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
