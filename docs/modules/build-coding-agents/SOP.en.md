# Coding Agent Development SOP

## Prerequisites

Confirm task scope, allowed files, protected files, test commands, completion criteria, permission mode, and approval owner. Ask when the project cannot answer these questions; the model must not expand scope on its own.

## Procedure

1. Record the current branch, `git status --short`, pre-existing dirty files, and protected-file fingerprints.
2. Run `inspectCodingRepository` and present language, package-manager, and test-command results as suggestions. When there are multiple candidates or no command, ask the user to choose TypeScript, JavaScript, or Python and provide the command.
3. Build a bounded repository map and freeze acceptance criteria in a six-phase engineering plan.
4. Reproduce the defect with the smallest target test. Stop editing and report the evidence gap if reproduction fails.
5. Read only the implementation and tests directly related to the failure, then state one verifiable root-cause hypothesis.
6. Capture a checkpoint before every `edit` or `write`, then change the fewest files and lines required. Never overwrite pre-existing user changes.
7. Run the target test first and the complete regression suite second. Record the actual command, exit code, duration, and artifact reference. Prose is not a substitute for evidence.
8. Enter bounded repair only from failure evidence. Stop at repeated-action, no-progress, repair-count, or budget limits.
9. Review `git_status` and `git_diff`, then use `EngineeringEvidenceLedger` to match changes, checkpoints, tests, and the final claim.
10. Validate with schemaVersion 2 outcome, trajectory, command, file, diff, state, and response graders.
11. For both TypeScript and Python, exercise single-file, cross-file, wrong-command, approval-denial, abort/resume, diff/restore, and dirty-worktree cases.
12. Record model, provider, version, platform, repetitions, success rate, tool count, latency, tokens, cost, approvals, failure class, safety events, and reviewer conclusion.
13. Request commit or publication authorization only after `ReleaseReadiness.ready`, security gates, and owner acceptance all pass.

## Stop conditions

- The defect cannot be reproduced or the test contract is unclear.
- The task requires writing outside the workspace, unauthorized network access, or disclosure of a real secret.
- The task would overwrite user changes, touch protected files, or expand scope.
- A non-reversible effect lacks explicit authorization or an external receipt.
- A security finding, evaluation, target test, or regression test fails.

Preserve the workspace and trace, then report verified facts, open decisions, and safe next choices to the owner.
