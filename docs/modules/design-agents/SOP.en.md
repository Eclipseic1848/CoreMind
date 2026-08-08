# Agent Construction Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Write one responsibility and explicit non-goals.
2. Attach only tools required for that responsibility.
3. Pass scenarios with one agent first.
4. Add agents only when responsibilities are genuinely separate.
5. Run the listed module tests and `npm run check:modules`.
6. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
