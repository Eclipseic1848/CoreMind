# Durable task phases (1.4 development)

[简体中文](durable-tasks.zh-CN.md)

TypeScript hosts import `TaskSession` and `TaskDefinition` from `coremind-ai`. This is unreleased development work. Python/Worker access remains separate; explicit keyed calls are described below.

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

## Durable waiting and host alarms

A phase returns `{ phase: "b", checkpoint: result, sleepUntil: deadline }` to commit its next phase, result, optional documents/entries and sleep state together. The deadline is an integer UTC epoch millisecond value from zero through `8_640_000_000_000_000`. Past deadlines are immediately eligible; combining sleepUntil with `done: true` is invalid. Queries return `status: "sleeping"` and `sleep: { sleepId, wakeAt }`. Every sleep has a distinct sleepId, so an old alarm cannot release a later sleep, even with the same deadline.

`nextWake()` returns the earliest `{ taskId, sleepId, wakeAt, remainingMs }`, breaking ties by taskId, or undefined when none remain. It recomputes the delay from durable state and the current clock; it never restores an old Promise/timer. Date.now is the default; tests may inject a trusted `clock`. This clock does not alter Runtime, tool, phase or Worker timeouts. A backwards clock change increases the remaining wait; admission still checks the absolute deadline.

Keep taskId, sleepId and a stable wakeId, then call `wake(taskId, wakeId, sleepId)`. It only persists ready; call `resume(taskId)` explicitly to execute the next phase. Direct resume also checks the deadline: early calls remain sleeping; due calls first persist ready, then execute a phase. No Run or phase timer remains active during the durable wait. Waiting never increases existing execution timeouts.

| Wake result | Host action |
|---|---|
| `accepted` | Ready and wakeId→sleepId were committed together; explicitly resume |
| `duplicate` | This taskId already admitted the same key/payload; no write, and do not treat an old alarm as a current phase instruction |
| `not_due` | No write or key reservation; query the deadline and retry the same key when due |
| `stale` | Not the current sleep; discard the notification without advancing |
| `terminal` | Completed or cancelled; discard without reviving the task |

Rebinding an accepted wakeId to another sleepId raises `task_wake_conflict`. Both identifiers start with a letter/digit, contain only letters, digits, underscores or hyphens, and are at most 128 characters. Concurrent writes return task_busy; after settlement, inspect state and the original key. Accepted keys remain in task state, subject to the existing 1 MiB TaskCommit limit; history is not unbounded. After an uncertain write acknowledgement, close/reopen and check the original key instead of assuming rollback.

Hosts own process startup, alarm delivery and ready-task recovery. If wake commits but the process exits before resume, query known tasks and explicitly resume ready ones at startup; nextWake alone cannot find them. Cancel terminates a waiting task and invalidates later alarms; closing an idle session releases its lease without cancelling durable waits. Migration does not run before the deadline. Definition upgrades require explicit resume migration; wake cannot migrate or grant authority.

Run `node examples/modules/recover-durable-runs/task-sleep.mjs` for an offline host example. After reopening it uses ordinary setTimeout, capped at `2_147_483_647` ms per timer, then rechecks eligibility. There is no new background scheduler service. Ordinary close/reopen does not replace actual process-exit tests.

Compatibility: existing non-sleep states remain readable; exhaustive status switches must handle sleeping. Older phase SDKs reject states containing sleep/wakes, so stop writers and back up task data before rollback. Never edit facts or force an older SDK to continue. This increment changes neither Protocol v2, Python/Worker task access nor legacy Run/Session data. See [ADR 0027](../adr/0027-durable-task-sleep-wake.md).

## Migration

Increase version when changing the definition, schema or handlers and supply `migrate(previous, signal)`, returning only `{ phase, checkpoint }`. Same-version drift, downgrades, missing migrations, exceptions and invalid results fail closed. Failed migration preserves original facts. Successful migration atomically saves version/state before executing a phase and is not repeated after restart. Completed/cancelled tasks need no migration.

Execution restarts at the persisted handler's top; closures, timers and JS stacks are not restored. Source fingerprints cannot detect closure or dependency behavior changes: hosts must increase definition versions explicitly. Migration transforms state only; it must not invoke business effects directly.

## Models and tools

Supply `runtime: { config, configDir, authorityVersion, ... }` at open and call `await context.run(prompt)` for a standard RunResult. Existing approval callbacks, tool definitions, lifecycle extensions, environment, maxSteps and stepTimeoutMs are supported. Replacement RunStores and caller-selected runId/resumeRunId are rejected. Permissions, budgets, Facts, cancellation and effect gates use the existing Runtime. Runtime timeouts remain unchanged; phase stepTimeoutMs defaults to 300000. Budgets belong to each Run, not the entire task.

Changed configuration, permissions or tools cannot be authorized through migration. Update authorityVersion when approval closures, external policy or credential routing change; only identity hashes are persisted. Host functions are trusted code. AbortSignal cannot forcibly terminate arbitrary JavaScript/I/O: handlers must cooperate with cancellation and launch business actions through governed entry points.

Legacy context.run still requires inspection of its pendingRunId without automatic resending. The explicit runCalls contract below reconciles only the original Run under stable-key and existing effect-proof rules; never delete the marker or create a replacement Run.

## Reproducible checks

```text
npm run build
node examples/modules/recover-durable-runs/task-phases.mjs
node examples/modules/recover-durable-runs/task-sleep.mjs
npx vitest run packages/coremind-runtime/src/task-session.test.ts packages/coremind-runtime/src/task-session-process.test.ts packages/coremind-runtime/src/task-session-runtime.test.ts --maxWorkers=1
npx vitest run packages/coremind-runtime/src/task-sleep.test.ts packages/coremind-runtime/src/task-sleep-process.test.ts --maxWorkers=1
```

The offline example demonstrates A→reopen→B→completed and explicit v1→v2 migration. Separate tests exercise actual process exits; ordinary close/reopen is not crash acceptance. See [ADR 0026](../adr/0026-task-phases-and-migrations.md) and the [recovery SOP](../modules/recover-durable-runs/SOP.en.md).

## Keyed calls (1.4 development)

A phase chooses either `context.run(prompt)` or `context.runCalls(handler)` and owns at most one Run. The latter invokes registered tools directly without a parent model request; it cannot replace configured workflow/loop verification. Every key shares the original Run budgets, authorization, approvals, cancellation, timeouts and ChildRun limits.

```ts
const result = await context.runCalls(async ({ executeTool }) => {
  const first = await executeTool("record", "lookup", { id: "42" });
  const same = await executeTool("record", "lookup", { id: "42" });
  return same.details;
});
```

Register `lookup` explicitly; see `examples/modules/recover-durable-runs/task-calls.mjs`. Configured delegation uses `executeTool("child", "delegate", { target, task, references: [] })` through the original ChildRun Coordinator. Await distinct keys sequentially. Duplicate in-flight keys join the original promise; completed keys return copies of durable results. `{ content, details }` must be finite JSON, without accessors/cycles or detected credentials. The existing 1 MiB TaskCommit limit still applies; use governed Artifact references for large outputs.

Scope binds the parent task, phase, definition version and phase Run, so looping back to a phase starts a fresh scope. Signatures bind canonical arguments, tool and the complete Runtime authority/capability identity. Recovery verifies unique-key order. Changed arguments/tools, omitted/inserted/reordered keys, same-version handler drift and capability drift are refused with TaskCommit audit. Hosts must still update definition versions/authorityVersion for changed closures, remote capability contracts, dependency behavior and credential routing: source fingerprints cannot detect them.

`session.calls(taskId)` returns historical key, tool, arguments, scope, stepId, RunId, state and committed result. Failed calls store only stable error markers; inspect original Run Facts for details. Completed/cancelled parents execute no more work. Records remain queryable; there is no automatic deletion, unbounded history or new archive service.

Order is intent → governed execution and receipt validation → critical Run step result → TaskCommit result ledger → handler return. A real process exit between the two result writes rebuilds from the same Run step without executing the tool again. A successful Run before phase commit permits only replay of recorded keys. An unfinished Run uses the original recovery gate: unknown effects pause; existing idempotency proof permits a new Call/attempt linked to the immutable old receipt. Failed/cancelled calls cannot be bypassed with a new key or Run. Unresolved Runs cannot migrate.

Uncertain write acknowledgements invalidate the holder. Preserve both task and Run facts, close/reopen and inspect original commits rather than assuming rollback. Arbitrary host JavaScript, clocks, randomness and direct networking are outside this contract. This is neither external exactly-once nor durable JS-stack execution or another Runtime.

Older tasks without callGroups remain readable. Older SDKs reject the new ledger and do not understand the task-specific Run marker: stop all writers and preserve both fact domains before rollback, and never resume a new task Run independently with an old SDK. Python/Worker access remains #367; this change does not alter the protocol. Release qualification still requires both platform CIs, all security gates and merge.

Run `task-calls.test.ts`, `task-calls-process.test.ts`, `task-calls-child.test.ts`, the offline `task-calls.mjs`, and original module gates. Coverage includes real process exits after intent/effect/Run-result/task-result/Run-finish, ChildRun limits, budgets, authorization, cancellation and uncertain result acknowledgements. See [ADR 0028](../adr/0028-keyed-task-calls.md).
