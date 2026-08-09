# Tools and Business Capabilities Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define the input JSON Schema, `effect.operations`, `effect.reversible`, and idempotency strategy. Use `external` and `false` when uncertain.
2. Implement deterministic code instead of hiding rules in prompts.
3. Cover success, invalid input, dependency failure, and repeated calls.
4. Declare non-standard path or URL fields with `pathFields` or `urlFields`, confirm permission and real recovery behavior for writes, and reject names that collide with built-in tools.
5. Use command and argument arrays for subprocesses, with timeout, output limit, cancellation signal, and a minimal environment.
6. Use only fixed `GitAdapter` reads for Git evidence. Stop and request separate authorization before mutating Git state.
7. Bound file input, output, and complexity before diff calculation, and reject paths outside the workspace or through escaping links.
8. Verify in Linux CI that bash cannot write outside the workspace or access the network; keep execution sequential so shared sandbox cleanup cannot race.
9. Verify on Windows that constrained modes reject the host shell and that execution requires all three explicitly open conditions.
10. Run the listed module tests and `npm run check:modules`.
11. Preserve trace, evaluation, and owner-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
