---
name: build-coding-agents
description: "Build and verify a CoreMind coding agent that reproduces defects, makes minimal edits, runs target and regression tests, preserves user changes, and reports traceable evidence. Use for coding-agent configuration, implementation, evaluation, review, or diagnosis."
---

# Coding Agents

1. Read the language-matched [module overview](../../docs/modules/build-coding-agents/README.en.md), [guide](../../docs/modules/build-coding-agents/GUIDE.en.md), and [SOP](../../docs/modules/build-coding-agents/SOP.en.md).
2. Establish scope, allowed and protected files, test commands, permission mode, and completion criteria before editing.
3. Capture the current branch, dirty-worktree baseline, and protected-file fingerprints. Preserve all pre-existing user changes.
4. Reproduce the smallest failing test. Stop if the defect or expected result cannot be proven.
5. State a testable root-cause hypothesis, then make the fewest required changes. Do not refactor adjacent code.
6. Run target and complete regression tests. Inspect `git_status`, `git_diff`, trace, checkpoints, budgets, approvals, and terminal outcome.
7. Use schemaVersion 2 outcome, trajectory, command, file, diff, state, and response graders. Repeat deterministic cases and keep live-provider evidence separate.
8. Treat Windows host-shell access as an explicitly open boundary, not isolation. Keep constrained workflows on path-aware tools; require the Linux isolation prerequisites before built-in shell execution.
9. Never commit, push, delete, publish, disclose secrets, or broaden scope without the corresponding user authorization.
10. Stop on any failed security gate, target test, regression test, protected-file check, or non-reversible effect without a receipt.

中文原则：先复现、后修改；只做最小变更；保留用户已有内容；测试、差异、Trace 和终态共同构成证据。full 不会关闭 deny、审计、Checkpoint、Diff 或恢复。
