# Configuration and Schema Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define schemaVersion, name, and agents first.
2. Select runtime, permissions, and quality explicitly.
3. Choose `workflow` for fixed steps and `loop` only for independent verification with bounded repair; never configure both.
4. Set iteration, repair, repeated-action, failure, and exhaustion bounds for every Loop. Agent verification requires passIf. Development host verification forbids passIf and requires [durable host replies](../../../examples/host-verification/README.en.md); unknown is not acceptance. Published 0.7.1 does not provide this mode.
5. Inventory every custom tool's real effects, set `effect.operations` and `effect.reversible`, and use `pathFields` or `urlFields` for nested targets.
6. Confirm that custom tool names do not collide with built-in names.
7. Run `coremind check` and resolve every error and warning.
8. Stop and ask the owner when business fields, verification rules, or effects are unknown.
9. Run the listed module tests and `npm run check:modules`.
10. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
