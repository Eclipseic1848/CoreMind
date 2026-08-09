# Python SDK and Tool Bridge Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Create and reuse one client.
2. Initialize before registering Python tools.
3. Annotate callable parameters and provide truthful `effect.operations` and `effect.reversible`.
4. Subscribe to events, handle approvals, and exhaustively consume all six RunOutcome terminal states.
5. Use resume_run only for paused or interrupted runs deemed safe.
6. Compare explicit Loop state order, pause-resume, exhaustion, and effect receipts with TypeScript.
7. Inject one tool-registration failure and confirm the client terminates the partially started worker; still close normal runs in a context manager or finally block.
8. Run the listed module tests and `npm run check:modules`.
9. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
