# CLI and TUI Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Create or adopt a project.
2. Check the local environment with doctor.
3. Develop with run or chat.
4. Accept with check and eval.
5. Use --print, --json-events, or --json in automation.
6. Run the listed module tests and `npm run check:modules`.
7. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
