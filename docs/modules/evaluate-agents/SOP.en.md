# Testing, Evaluation, and Quality Gates Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define business success first.
2. Create happy, boundary, failure, and denial scenarios.
3. Run coremind check.
4. Run coremind eval.
5. Use ReleaseReadiness—not a fluent answer—to decide release.
6. Run the listed module tests and `npm run check:modules`.
7. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
