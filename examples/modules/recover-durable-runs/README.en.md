# Durable Runs and Recovery Example

## Goal

Verify resume after pause and non-replay of committed effects without creating a second business Loop.

## Procedure

These commands are for an application project with a configured write tool and human approval. This example directory has no standalone `coremind.yaml` and cannot run them directly.

```text
coremind run coremind.yaml --prompt "write acceptance text to result.md" --json-events
```

1. Press `n` at write approval and confirm `snapshot.outcome.status=paused` and `snapshot.operation.state=paused`.
2. Record the `runId` from the final event.
3. Continue with:

```text
coremind run coremind.yaml --resume <runId> --json-events
```

4. Approve the write and verify exactly one checkpoint, one committed effect receipt, and one target-file change.
5. Resume the same `runId` again and confirm that the terminal operation is rejected instead of writing again.
6. Compare the compatibility fields with `snapshot` and confirm matching run id, operation, outcome, metrics, and evidence.

## Model-free TaskCommit example (1.4 release line line)

After installing repository dependencies, run from the root:

```text
npm run build
node examples/modules/recover-durable-runs/task-commit.mjs
```

The [source](task-commit.mjs) atomically saves a checkpoint, document and text entry in its own temporary workspace, closes/reopens to check reconstruction, then checks same-content idempotency and changed-content conflicts. It prints `TaskCommit OK` and removes only its own temporary directory. It reads no credentials and calls no model or external business service.

This demonstrates the internal storage contract, not task execution or sleep/wake. Real process exit windows are covered by `task-commit-crash.test.ts`; normal close/reopen in this example is not crash acceptance.

## Fault injection

Run from the repository root:

```text
npx vitest run packages/coremind-runtime/src/invariant-checker.test.ts packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
```

The checker test runs the tracked current-format and 0.3.0 fixtures in `gate` mode. Do not substitute a local `.coremind` directory for acceptance input.

Return to the [English guide](../../../docs/modules/recover-durable-runs/GUIDE.en.md).

## Offline task phase and migration example

After building, run `node examples/modules/recover-durable-runs/task-phases.mjs`. It imports TaskSession from public coremind-ai, checks A→reopen→B→completed and explicit v1→v2 migration, without credentials or model calls. It prints `Task phases and migration OK` and removes only its own temporary workspace. Actual process exits are tested separately in task-session-process.test.ts.

See the [task guide](../../../docs/guides/durable-tasks.en.md).

## Offline durable wait and host alarm example

After building, run `node examples/modules/recover-durable-runs/task-sleep.mjs`. It commits A's result and deadline, reopens, builds a capped ordinary timer from nextWake, then uses wake/resume to execute B. It prints `Durable sleep and host alarm OK`, needs no credentials and removes only its own temporary directory. Real host startup must also query known ready tasks. This example's close/reopen does not replace the actual process exits in task-sleep-process.test.ts.

## Keyed calls (1.4 release line)

After building, run `node examples/modules/recover-durable-runs/task-calls.mjs`. It checks duplicate keys and reopen after a committed result, with exactly one real tool execution. A fixed dummy key is used without model requests. It prints `Keyed calls and durable reuse OK` and removes only its own temporary directory. Real exits are covered separately by task-calls-process.test.ts.

## Real-process restart composition

After building, run `node examples/modules/recover-durable-runs/task-restart.mjs`. Phase A atomically saves a keyed result and wait; the parent observes child exit, starts a new process and explicitly wakes the durable wait. Phase B consumes the saved result. Assertions compare process identities, the original Run/key/result and a single execution record, without real Provider requests or changing subprocess limits.

This validates a controlled offline window, not external exactly-once. See the matching [sync/async Python example](../embed-coremind-python/tasks.py).
