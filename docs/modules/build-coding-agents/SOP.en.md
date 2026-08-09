# Coding Agent Development SOP

## Prerequisites

Confirm task scope, allowed files, protected files, test commands, completion criteria, permission mode, and approval owner. Ask when the project cannot answer these questions; the model must not expand scope on its own.

## Procedure

1. Record the current branch, `git status --short`, pre-existing dirty files, and protected-file fingerprints.
2. Reproduce the defect with the smallest target test. Stop editing and report the evidence gap if reproduction fails.
3. Read only the implementation and tests directly related to the failure, then state one verifiable root-cause hypothesis.
4. Change the fewest files and lines required to satisfy the task. Never overwrite pre-existing user changes.
5. Run the target test first and the complete regression suite second. Preserve failures as failures; prose is not a substitute for test evidence.
6. Use `git_status` and `git_diff` to review scope, untracked files, credentials, generated artifacts, and accidental formatting.
7. Validate with schemaVersion 2 outcome, trajectory, command, file, diff, state, and response graders.
8. Exercise path escape, approval denial, cancellation, repeated-action, and dirty-worktree protection at least once.
9. Record model, provider, version, platform, repetitions, pass rate, tool failures, approvals, final tests, and reviewer conclusion.
10. Request commit or publication authorization only after `ReleaseReadiness.ready`, security gates, and owner acceptance all pass.

## Stop conditions

- The defect cannot be reproduced or the test contract is unclear.
- The task requires writing outside the workspace, unauthorized network access, or disclosure of a real secret.
- The task would overwrite user changes, touch protected files, or expand scope.
- A non-reversible effect lacks explicit authorization or an external receipt.
- A security finding, evaluation, target test, or regression test fails.

Preserve the workspace and trace, then report verified facts, open decisions, and safe next choices to the owner.
