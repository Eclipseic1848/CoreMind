# Trace, RunState, and Debugging Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Locate the run by runId.
2. Rebuild the timeline by sequence.
3. Inspect backward from the first fatal error or policy_denied.
4. Resume only after confirming a complete step_output boundary.
5. Reproduce from evidence before changing code.
6. Keep before-and-after traces.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
