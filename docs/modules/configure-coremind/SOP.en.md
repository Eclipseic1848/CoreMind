# Configuration and Schema Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define schemaVersion, name, and agents first.
2. Select runtime, permissions, and quality explicitly.
3. Run coremind check and resolve every error and warning.
4. Stop and ask the owner when business fields are unknown.
5. Run the listed module tests and `npm run check:modules`.
6. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
