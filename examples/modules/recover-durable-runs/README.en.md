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

## Model-free TaskCommit example (1.4 development line)

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
