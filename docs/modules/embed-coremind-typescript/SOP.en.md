# TypeScript SDK Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Import public APIs only from coremind-ai.
2. Validate external configuration with parseAndValidate.
3. Give every defineTool tool a JSON Schema and `effect`, then inject an approval handler.
4. Exhaustively consume all six RunOutcome terminal states and structured events; do not handle only success and exceptions.
5. For explicit Loops, verify state order, pause-resume, exhaustion, timeout, abort, and effect receipts.
6. Do not depend on package-internal paths.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
