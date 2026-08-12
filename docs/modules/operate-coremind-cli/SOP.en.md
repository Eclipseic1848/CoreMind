# CLI and TUI Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Create or adopt a project.
2. Check the local environment with doctor.
3. Develop with run or chat.
4. Accept with check and eval.
5. Use TUI for people, `--print` for text pipes, and `--json-events` for automation; never pass the last two options together.
6. Automation must check both the exit code and final `run_result`, while preserving stderr diagnostics.
7. Inject denial, budget exhaustion, timeout, and abort, then verify `2/3/124/130` respectively.
8. For an explicit Loop, inject verification failure, pause-resume, and exhaustion; compare TUI, readline, and JSONL state order.
9. Confirm resume does not replay completed steps or committed effects and requires human reconciliation for unknown effects.
10. Compare TUI `/status`, `/artifacts`, and `/context` with the final JSONL `snapshot`; fields must match actual files and run state.
11. Run the listed module tests and `npm run check:modules`.
12. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
