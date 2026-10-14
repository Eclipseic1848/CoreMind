# TypeScript SDK Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Import public APIs only from coremind-ai.
2. Validate external configuration with parseAndValidate.
3. Give every defineTool tool a JSON Schema and `effect`, then inject an approval handler.
4. Exhaustively consume all six RunOutcome terminal states and structured events; do not handle only success and exceptions.
5. For explicit Loops, verify state order, pause-resume, exhaustion, timeout, abort, and effect receipts; host verification must also check candidate identity, durable replies, and final outcome.
6. Do not depend on package-internal paths.
7. Across processes, languages, or storage, transmit only `RunResult.snapshot`; fully validate operation, outcome, metrics, evaluation, trace, checkpoints, artifacts, and extension receipts.
8. Run the listed module tests and `npm run check:modules`.
9. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

For 1.1 development controls, first establish active Run readiness, retain controlId, optionally pin the expected runId, then call `ChatSession.steer/followUp`. Check the five control receipt states separately from input consumption/discard events. Inject accepted/applied commit failures, terminal races, and cold recovery; verify no delivery to a later Run, no automatic redelivery of applied controls without confirmed consumption, and no permission expansion. Preserve Session, original-input, and effect-recovery gates. Applied does not mean consumed, and the crash window remains.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
