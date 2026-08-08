# Python SDK and Tool Bridge Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Create and reuse one client.
2. Initialize before registering Python tools.
3. Annotate callable parameters.
4. Subscribe to events and handle approvals.
5. Use resume_run only for unfinished runs deemed safe.
6. Close the worker in a context manager or finally block.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
