# Testing, Evaluation, and Quality Gates Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define business success first.
2. Create happy, boundary, failure, denial, timeout, and cancellation scenarios.
3. Use schemaVersion 1 for compatible text checks; use schemaVersion 2 when tools, files, diffs, and runtime-state evidence matter.
4. Include an outcome grader in every schemaVersion 2 scenario, then add trajectory, command, file, diff, state, and response graders according to risk.
5. Capture the dirty-worktree and protected-file baseline, and declare allowed plus forbidden paths before execution.
6. Run `coremind check` and `coremind eval`; repeat strict scenarios at least three times.
7. Keep deterministic offline and live-model results separate. Record model, provider, platform, repetitions, cost/tokens, and data-egress authorization for live runs.
8. Use release readiness, security gates, final tests, and owner review—not fluent prose—to decide release.
9. Run the listed module tests and `npm run check:modules`.
10. Preserve trace, grader, diff, and human-approval evidence; do not publish without explicit authorization.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
