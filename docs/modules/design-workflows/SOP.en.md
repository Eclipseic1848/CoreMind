# Workflows and Bounded Loops Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Map input and output dependencies.
2. Keep deterministic operations in tools or normal code.
3. Give every retry a verifiable condition.
4. Set maxSteps, maxRetries, and timeouts.
5. Inject failures and confirm they never masquerade as success.
6. Resume only from complete step_output boundaries and never claim arbitrary call-stack recovery.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
