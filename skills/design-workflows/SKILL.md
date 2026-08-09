---
name: design-workflows
description: "Design, implement, test, or diagnose fixed workflows and explicit bounded verify-repair loops in CoreMind. Use when a task needs orchestration, convergence checks, repair limits, pause-resume, retry classification, or effect-safe recovery."
---

# Workflows and Explicit Bounded Loops

1. Read the [module contract](../../docs/modules/design-workflows/README.en.md) and its language-matched guide.
2. Confirm the owner, success rule, verification rule, allowed repair scope, permissions, budgets, and irreversible effects before selecting an architecture.
3. Use ordinary code for deterministic logic, `workflow` for fixed dependencies, and `loop` only for a genuine generate-verify-repair cycle.
4. Write failing contracts before implementation for verification failure, exhaustion, no progress, approval denial, timeout, abort, transient errors, and resume.
5. Set `maxIterations`, `maxRepairs`, `maxRepeatedAction`, `onFailure`, and `onExhausted`; never solve a defect by silently raising bounds.
6. Inspect RunOutcome, ordered `loop_state` events, budgets, checkpoints, and effect receipts. A fluent answer without a passing verifier is not success.
7. Resume only from a persisted stable CoreMind state. Do not replay committed effects, and pause for human reconciliation when an effect is unknown.
8. Run the tests and commands listed in [module.yaml](../../docs/modules/design-workflows/module.yaml) and the [development SOP](../../docs/modules/design-workflows/SOP.en.md).
9. Stop on unconfirmed business rules, failed security gates, or non-reversible actions without explicit authorization. Never commit, push, tag, or publish implicitly.

中文原则：固定依赖优先 Workflow；只有需要“生成—验证—修复—再验证”时才使用显式 Loop。失败不得伪成功，`full` 不得关闭预算、审计、checkpoint、Effect Receipt 或恢复保护。
