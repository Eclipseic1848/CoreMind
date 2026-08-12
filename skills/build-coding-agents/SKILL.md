---
name: build-coding-agents
description: "Build and verify a CoreMind coding agent that reproduces defects, makes minimal edits, runs target and regression tests, preserves user changes, and reports traceable evidence. Use for coding-agent configuration, implementation, evaluation, review, or diagnosis."
---

# Coding Agents

1. Read the language-matched [module overview](../../docs/modules/build-coding-agents/README.en.md), [guide](../../docs/modules/build-coding-agents/GUIDE.en.md), and [SOP](../../docs/modules/build-coding-agents/SOP.en.md).
2. Establish scope, allowed and protected files, permission mode, and completion criteria before editing.
3. Run `inspectCodingRepository`; detection is advisory. Ask the user to select TypeScript, JavaScript, or Python and the package manager/test command whenever evidence is ambiguous.
4. Capture the current branch, dirty-worktree baseline, and protected-file fingerprints. Preserve all pre-existing user changes.
5. Build the repository map and six-phase engineering plan, then reproduce the smallest failing test. Stop if the defect or expected result cannot be proven.
6. State a testable root-cause hypothesis. Capture a checkpoint before every edit/write, then make the fewest required changes without adjacent refactoring.
7. Run target and complete regression tests. Record actual commands and exit codes; inspect `git_status`, `git_diff`, trace, checkpoints, budgets, approvals, and terminal outcome.
8. Enter bounded repair only from failure evidence. Stop on repeated action, no progress, exhausted repair count, or exhausted budget.
9. Require Runtime-emitted `engineering_evidence` backed by actual tool results, successful target and regression commands, a pre-write checkpoint, and `git_diff`. A model-produced `PASS` or manually filled legacy ledger is never sufficient.
10. Treat Windows host-shell access as an explicitly open boundary, not isolation. Keep constrained workflows on path-aware tools; require the Linux isolation prerequisites before built-in shell execution.
11. Never commit, push, delete, publish, disclose secrets, or broaden scope without the corresponding user authorization.
12. Stop on any failed security gate, target test, regression test, protected-file check, or non-reversible effect without a receipt.

中文原则：先复现、后修改；只做最小变更；保留用户已有内容；测试、差异、Trace 和终态共同构成证据。full 不会关闭 deny、审计、Checkpoint、Diff 或恢复。
