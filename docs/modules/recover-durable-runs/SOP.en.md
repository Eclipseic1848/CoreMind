# Durable Runs and Recovery SOP

## 1. Confirm before execution

1. Record the workspace, configuration file, fingerprint, entry point, and permission mode.
2. Classify each tool effect as file, process, network, or external and state whether it is reversible or replay-safe.
3. Confirm whether the business system accepts an idempotency or transaction key. Never promise safe replay without one.
4. Use a copy of a legacy Session for acceptance; do not experiment on the only source.

## 2. Run lifecycle

1. Allocate `runId`, `operationId`, and `correlationId`, then persist `ACCEPT`.
2. Transition to `running` before execution.
3. Transition to `paused` with a stable `finishReason` when approval or human judgment is required.
4. On cancellation, enter `aborting` first and close as `failed` with an aborted reason after cleanup.
5. Enter `completed` only after verification. Exceptions, timeouts, and exhausted budgets enter `failed`.
6. Create `RunResult.snapshot` after the terminal transition. All four entry points must serialize and validate that snapshot instead of deriving a second status model.

## 3. Tools and effects

1. Allocate a `callId` and derive an `idempotencyKey` from run, step, and call.
2. Create a checkpoint before a write. Irreversible commands still require an explicit non-reversible record.
3. Persist a `started` effect receipt before execution.
4. Persist `committed` after confirmed success or `unknown` when the result is uncertain.
5. During recovery, skip `committed` effects only with their stable completed step. Pause for a committed effect in an incomplete step or for any unknown effect.

## 4. Session migration

1. Validate the legacy header, session id, JSON lines, and supported entry types.
2. Create `<id>.jsonl.v3.backup` in the same directory and compare bytes.
3. Create an incomplete migration marker in the versioned repository.
4. Convert entries and commit through a temporary file plus atomic rename.
5. Reopen the target and validate its completion marker and context.
6. Publish the stable public path last. No earlier failure may replace the legacy file.
7. Run migration again and confirm that no message or authoritative session is duplicated.

## 5. Crash decisions

| Evidence | Action |
|---|---|
| Only the final JSONL line is incomplete after valid records | Remove the tail and atomically republish |
| Whole-file parsing fails or sequence is broken | Fail closed and recover from backup or human evidence |
| A lock exists and its writer is active | Wait; do not delete the lock |
| A lock exists and the writer is proven absent | Back up lock and data, remove the lock manually, then retry |
| Operation is completed or failed | Do not resume; create a new task |
| Effect outcome is unknown | Query the external system and remain paused if still uncertain |

## 6. Verification

```text
npx vitest run packages/coremind-runtime/src/operation-state.test.ts packages/coremind-runtime/src/run-state.test.ts packages/coremind-runtime/src/session-conformance.test.ts packages/coremind-runtime/src/session.test.ts packages/coremind-runtime/src/checkpoint.test.ts packages/coremind-runtime/src/snapshot.test.ts packages/coremind-runtime/src/runtime.test.ts packages/coremind-worker/src/server.test.ts --maxWorkers=1
npm run check:modules
```

Use the same command on Linux. Real process crashes, competing writers, and filesystem rename behavior require separate Windows and Linux acceptance.
