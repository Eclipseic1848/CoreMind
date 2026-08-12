# Providers and Models Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. List providers inherited from the locked version.
2. Use apiKeyEnv and never store secrets in YAML.
3. Verify contracts with an offline mock.
4. After obtaining data-egress and model-cost approval, run all seven live checks: streaming, tool call, structured result, multi-turn, abort, error mapping, and long context.
5. The same CoreMind version, provider, and model must pass all seven. Keep failed or incomplete older evidence configurable and unverified.
6. Run `npm run providers:matrix` and verify that incomplete evidence is never promoted.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
