---
name: evaluate-agents
description: "Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes. Use when creating, changing, reviewing, or diagnosing the testing, evaluation, and quality gates capability in a CoreMind project."
---

# Testing, Evaluation, and Quality Gates

1. Read [the module contract](../../docs/modules/evaluate-agents/README.en.md) and the language-matched guide only when implementation details are needed.
2. Identify the business owner, accepted inputs and outputs, failure conditions, permission mode, and quality profile.
3. Follow [the SOP](../../docs/modules/evaluate-agents/SOP.en.md) in order. Do not invent unresolved business rules or broaden the requested architecture.
4. Add or update a failing test before implementation, then make the smallest change that passes it.
5. Use schemaVersion 2 whenever tools or files matter. Require an outcome grader, then select trajectory, command, file, diff, state, and response graders according to the failure risks.
6. Capture dirty-worktree and protected-file baselines before each attempt. Preserve user changes and reject paths outside the workspace.
7. Inspect RunOutcome, Trace, budgets, approvals, checkpoints, grader evidence, final tests, and diffs. Treat a fluent answer without evidence as unverified.
8. Separate deterministic offline evidence from live-provider evidence, and label automated review honestly.
9. For comparisons, freeze experiment id/version/seed, arm weights, input fingerprints, environment, budget, and graders before running. Preserve the complete trace and truthful outcome for every arm.
10. Run the tests listed in [module.yaml](../../docs/modules/evaluate-agents/module.yaml) and `npm run check:modules`.
11. Stop on a security failure or non-reversible action that lacks explicit user authorization. Never push, tag, or publish implicitly.

中文执行原则：先确认业务规则，再按 SOP 实现；失败不得伪装成成功；full 只改变审批强度，不得关闭显式 deny、审计、checkpoint 和恢复。路径感知文件工具与 shell 的平台边界必须分别验证。
