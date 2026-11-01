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
6. Validate records in persisted order. Retry only work proven replay-safe: `not_started` may be reconsidered; pause for `started`, `unknown`, or committed effects outside a stable completed step.
7. Back up a legacy Session before conversion, publish the alias last, and rerun migration to prove idempotency.
8. Compare the CLI, Worker, TypeScript, and Python snapshots; reject schema, `runId`, outcome, or key-set drift.
9. Run `checkInvariantFacts` against facts in persisted order. Use `eval` for diagnostics and `gate` for tracked deterministic fixtures; never use ignored `.coremind` output as release evidence.
10. Preserve the meaning of legacy facts at their occurrence boundary. TurnIds appended by a newer Resume must not retroactively reclassify 0.3.0 records.
11. Run every test listed in [module.yaml](../../docs/modules/recover-durable-runs/module.yaml), then `npm run check:modules` and the repository gates.
12. Never delete a lock until the writer is proven absent. Never push, tag, or publish implicitly.

For the opt-in internal task mode, follow [ADR 0025](../../docs/adr/0025-explicit-task-commit-authority.md). Preserve one TaskCommit authority for checkpoints, typed documents and text entries; never mirror those entries into legacy Session facts. Validate revision, commitId content, schemas and workspace identity before the critical write. After uncertain I/O, close/reopen and check the original commitId rather than assuming rollback. Task logs do not permit ordinary Run torn-tail repair. Run `task-commit.test.ts`, `task-commit-crash.test.ts` and the [model-free example](../../examples/modules/recover-durable-runs/task-commit.mjs). This storage foundation does not implement scheduling, wakeups, task migration or public SDK/Worker access.

中文执行原则：恢复不是重新运行；先判定权威状态和副作用证据，再决定跳过、重试或请求人工处理。不能无损迁移时保留原文件并失败关闭。

显式任务模式以单条 TaskCommit 同时提交 checkpoint/document/entry；校验和持久回执未完成前不得发布部分投影。未知 I/O 后保留原 commitId 重开核对，不删坏尾行，不把单机进程崩溃保证写成外部 exactly-once。
