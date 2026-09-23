# Python SDK and Tool Bridge Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Create and reuse one client.
2. With default Protocol v1, initialize before registering Python tools. Negotiate Protocol v2 explicitly and do not register Python callables there.
3. For v1 callables, annotate parameters and provide truthful `effect.operations` and `effect.reversible`.
4. Subscribe to events and handle approvals. Exhaustively consume all six v1 RunOutcome terminal states; in v2, read the final Projection with `query(runId)`.
5. Use resume_run only for paused or interrupted runs deemed safe.
6. Compare explicit Loop state order, pause-resume, exhaustion, and effect receipts with TypeScript. For host verification, also check request identity, candidate hash, durable decision, and final Projection outcome.
7. For the v1 tool bridge, inject a registration failure and confirm the client terminates the partially started worker; still close normal runs in a context manager or finally block.
8. Compare a v1 Python snapshot with a TypeScript sample. Tampering with operation, outcome, metrics, trace, checkpoint, or artifact fields must produce stable `invalid_run_snapshot` failure.
9. Run the listed module tests and `npm run check:modules`.
10. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
