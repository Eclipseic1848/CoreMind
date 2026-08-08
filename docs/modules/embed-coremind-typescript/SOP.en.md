# TypeScript SDK Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Import public APIs only from coremind-ai.
2. Validate external configuration with parseAndValidate.
3. Inject defineTool tools and an approval handler.
4. Consume RunOutcome and structured events.
5. Do not depend on package-internal paths.
6. Run the listed module tests and `npm run check:modules`.
7. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
