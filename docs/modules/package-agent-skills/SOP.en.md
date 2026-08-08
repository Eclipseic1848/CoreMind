# Skill and SOP Loading Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Describe trigger contexts in frontmatter.
2. Keep only non-obvious procedure in the body.
3. Move detailed material into one-level references.
4. Validate the format and exercise it on a real task.
5. Run the listed module tests and `npm run check:modules`.
6. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
