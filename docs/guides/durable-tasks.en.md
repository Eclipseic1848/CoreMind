# Durable task phases (1.4 development)

[简体中文](durable-tasks.zh-CN.md)

TypeScript hosts import `TaskSession` and `TaskDefinition` from `coremind-ai`. This is unreleased development work. Python, Worker, sleep/wake and nested calls are separate deliveries.

```ts
import { TaskSession, type TaskDefinition } from "coremind-ai";

const task: TaskDefinition = {
  type: "counter", version: 1, initialPhase: "a",
  checkpointSchema: { type: "integer" },
  phases: {
    a: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1 }),
    b: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1, done: true }),
  },
};
const tasks = await TaskSession.open({ workspace: process.cwd(), sessionId: "demo", definitions: [task] });
try {
  if (!tasks.query("job")) await tasks.start({ taskId: "job", type: "counter", checkpoint: 0 });
  await tasks.resume("job");
  await tasks.resume("job");
  console.log(tasks.query("job"));
} finally {
  await tasks.close();
}
```

`start` persists initial state without running a handler. Each `resume` executes one phase; its next phase/checkpoint becomes visible only after a durable commit. Completed/cancelled tasks return their existing terminal state. `cancel(taskId)` aborts the active phase; it does not undo external effects. Concurrent session writes are rejected rather than queued.

A phase can return `documents` and `entries` in the same atomic commit; documents must match documentSchemas registered at open. Queries return copies. Do not open internal TaskCommitSession alongside an active public TaskSession or bypass execution contracts through internal storage.

## Migration

Increase version when changing the definition, schema or handlers and supply `migrate(previous, signal)`, returning only `{ phase, checkpoint }`. Same-version drift, downgrades, missing migrations, exceptions and invalid results fail closed. Failed migration preserves original facts. Successful migration atomically saves version/state before executing a phase and is not repeated after restart. Completed/cancelled tasks need no migration.

Execution restarts at the persisted handler's top; closures, timers and JS stacks are not restored. Source fingerprints cannot detect closure or dependency behavior changes: hosts must increase definition versions explicitly. Migration transforms state only; it must not invoke business effects directly.

## Models and tools

Supply `runtime: { config, configDir, authorityVersion, ... }` at open and call `await context.run(prompt)` for a standard RunResult. Existing approval callbacks, tool definitions, lifecycle extensions, environment, maxSteps and stepTimeoutMs are supported. Replacement RunStores and caller-selected runId/resumeRunId are rejected. Permissions, budgets, Facts, cancellation and effect gates use the existing Runtime. Runtime timeouts remain unchanged; phase stepTimeoutMs defaults to 300000. Budgets belong to each Run, not the entire task.

Changed configuration, permissions or tools cannot be authorized through migration. Update authorityVersion when approval closures, external policy or credential routing change; only identity hashes are persisted. Host functions are trusted code. AbortSignal cannot forcibly terminate arbitrary JavaScript/I/O: handlers must cooperate with cancellation and launch business actions through governed entry points.

A pendingRunId means the original Run requires reconciliation. Resume returns `task_run_unresolved` without resending. Preserve the task directory and original Run Facts, and inspect status/effect receipts. This version does not clear this marker or automatically reconcile results. Do not edit journals or create replacement Runs to bypass it. Multiple keyed calls and deterministic result reuse belong to #365.

## Reproducible checks

```text
npm run build
node examples/modules/recover-durable-runs/task-phases.mjs
npx vitest run packages/coremind-runtime/src/task-session.test.ts packages/coremind-runtime/src/task-session-process.test.ts packages/coremind-runtime/src/task-session-runtime.test.ts --maxWorkers=1
```

The offline example demonstrates A→reopen→B→completed and explicit v1→v2 migration. Separate tests exercise actual process exits; ordinary close/reopen is not crash acceptance. See [ADR 0026](../adr/0026-task-phases-and-migrations.md) and the [recovery SOP](../modules/recover-durable-runs/SOP.en.md).
