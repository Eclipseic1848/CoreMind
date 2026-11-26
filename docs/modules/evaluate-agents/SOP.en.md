# Testing, Evaluation, and Quality Gates Development SOP

## Prerequisites

Read the [module overview](README.en.md), then confirm the business owner, inputs, outputs, failure conditions, and permission boundary.

## Procedure

1. Define business success first.
2. Create happy, boundary, failure, denial, timeout, and cancellation scenarios.
3. Use schemaVersion 1 for compatible text checks; use schemaVersion 2 when tools, files, diffs, and runtime-state evidence matter.
4. Include an outcome grader in every schemaVersion 2 scenario, then add trajectory, command, file, diff, state, and response graders according to risk.
5. Capture the dirty-worktree and protected-file baseline, and declare allowed plus forbidden paths before execution. Verify that diff `preserveExisting: false` still enforces `allowedPaths`, `forbiddenPaths`, `requiredPaths`, and `maxChangedFiles` against baseline-to-final status or content differences. Dirty files with unchanged status and content must not count as changes, deletion of a previously untracked file must count, and the default `true` protection must remain unchanged.
6. Run `coremind check` and `coremind eval`; repeat strict scenarios at least three times.
7. Keep deterministic offline and live-model results separate. Record model, provider, platform, repetitions, cost/tokens, and data-egress authorization for live runs.
8. Use release readiness, security gates, final tests, and owner review—not fluent prose—to decide release.
9. When comparing strategies, freeze the experiment id, version, seed, arm weights, and input-fingerprint rule. Use the same task, budget, provider, and graders for every arm.
10. Use `runExperiment` to retain environment, assignment hash, truthful outcome, metrics, complete trace, and graders; do not store only model prose.
11. Run the listed module tests and `npm run check:modules`.
12. Preserve trace, grader, diff, and human-approval evidence; do not publish without explicit authorization.

## Regression for the five optional capabilities

Run the [minimal example](../../../examples/modules/evaluate-agents/README.en.md#offline-regression-for-the-five-optional-capabilities) and retain its JSON report. Fix the questions, sources, expected outcomes, budget and acceptance criteria before comparing arms or repeating a run. When replacing the synthetic tasks, retain questions held out from debugging and record the dataset and fixture revisions.

| Capability | Grading evidence |
| --- | --- |
| Knowledge | Score positive Top1/Top5 retrieval, answer text, source version and locator, correct abstentions, and unsupported answers independently. Unanswerable questions can still retrieve similar content. |
| Hindsight memory | Count falsely admitted candidates and wrongly adopted or missed confirmed experiences. Check current version, scope, and confirmation status. |
| Skill | Run the same task with the Skill enabled and disabled. Track valid outcomes, wrong or unnecessary triggers, and usage by arm. Use fixture usage for offline checks and report real costs from authorized usage and prices. |
| Tools | Compare actual local, stdio and HTTP calls. Check call count, approval, original arguments and structured results. |
| Ontology | Check request ID, target, previous state and outcome. Confirm that replay returns the same receipt and that a missing business receipt yields `unknown` and blocks a further write. |

The aggregate `passed` flag follows the exit status of each evaluation. Inspect a failing domain's error and captured evidence, then repeat with the same dataset and fixtures after the fix. Use a separately authorized run to evaluate live models and the business environment.

## Stop conditions

Stop for unconfirmed business rules, non-reversible side effects, access outside the workspace, unavailable real credentials, or failed security gates. Ask the owner instead of expanding scope.
