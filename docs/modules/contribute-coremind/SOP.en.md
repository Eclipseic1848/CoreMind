# Source and Community Contribution Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Read the handoff and authoritative plan first.
2. Write a failing test before the smallest implementation.
3. Synchronize module contracts and bilingual docs.
4. Generate the provider matrix and build the bilingual documentation site.
5. Build in dependency order and run code, documentation, and release gates.
6. Show the diff and wait for explicit release authorization.
7. Run the listed module tests and `npm run check:modules`.
8. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
