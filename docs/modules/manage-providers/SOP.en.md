# Providers and Models Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. List providers inherited from the locked version.
2. Use apiKeyEnv and never store secrets in YAML.
3. Verify contracts with an offline mock.
4. Mark certification only after real streaming, tool, multi-turn, and error tests pass.
5. Run the listed module tests and `npm run check:modules`.
6. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
