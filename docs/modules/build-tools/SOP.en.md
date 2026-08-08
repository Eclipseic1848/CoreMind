# Tools and Business Capabilities Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define the input JSON Schema, side effects, and idempotency strategy.
2. Implement deterministic code instead of hiding rules in prompts.
3. Cover success, invalid input, dependency failure, and repeated calls.
4. Confirm permission and recovery behavior for writes.
5. Verify in Linux CI that bash cannot write outside the workspace or access the network.
6. Keep Linux bash execution sequential so shared sandbox cleanup cannot race.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
