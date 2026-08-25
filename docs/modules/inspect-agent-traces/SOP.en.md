# Trace, RunState, and Debugging Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Locate the run by runId.
2. Rebuild the timeline by sequence.
3. Inspect backward from the first fatal error or policy_denied.
4. For a Loop, validate snapshot version, configuration fingerprint, and the latest stable phase.
5. Resume only after confirming complete step output, no replay of committed effects, and human reconciliation of unknown effects.
6. Reproduce from evidence before changing code.
7. Use fake credentials, body content, and a URL with a sensitive query value to verify pre-persistence redaction while keeping ordinary test commands auditable for graders.
8. Keep before-and-after traces.
9. Replay with fixed Facts and the actual Working Set fixture. Compare Fact, request, and replay fingerprints; treat every mismatch as corrupt state rather than falling back to approximate replay.
10. For Telemetry, verify the persisted configuration, activation sequence, same-run consent, feedback prefix, content retention/revocation declarations, and an exact-origin receipt from a trusted Adapter. The receipt is not evidence of real DNS/TLS certification.
11. Run the listed module tests and `npm run check:modules`.
12. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
