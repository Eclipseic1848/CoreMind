---
name: recover-durable-runs
description: "Design, diagnose, or verify CoreMind durable operation state, RunState atomicity, Session migration, checkpoints, effect receipts, and crash recovery without replaying uncertain side effects."
---

# Durable Runs and Recovery

1. Read the [module contract](../../docs/modules/recover-durable-runs/README.en.md) and the matching guide.
2. Identify the authoritative owner for conversation, run lifecycle, side effects, and usage. Do not add a parallel Loop.
3. Follow the [SOP](../../docs/modules/recover-durable-runs/SOP.en.md) in order.
4. Reproduce the failure with a fault-injection test before changing persistence or recovery behavior.
5. Preserve `runId`, `operationId`, `correlationId`, `callId`, idempotency key, checkpoint, effect receipt, terminal evidence, and the shared `RunResult.snapshot`.
6. Retry only work proven replay-safe. Pause for unknown effects or committed effects outside a stable completed step.
7. Back up a legacy Session before conversion, publish the alias last, and rerun migration to prove idempotency.
8. Compare the CLI, Worker, TypeScript, and Python snapshots; reject schema, `runId`, outcome, or key-set drift.
9. Run every test listed in [module.yaml](../../docs/modules/recover-durable-runs/module.yaml), then `npm run check:modules` and the repository gates.
10. Never delete a lock until the writer is proven absent. Never push, tag, or publish implicitly.

中文执行原则：恢复不是重新运行；先判定权威状态和副作用证据，再决定跳过、重试或请求人工处理。不能无损迁移时保留原文件并失败关闭。
