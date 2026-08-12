# Durable Runs and Recovery Guide

## When to use it

Use this recovery contract when a task writes files, runs commands, verifies across turns, or must continue after approval denial, terminal closure, or a network interruption. A one-shot read-only answer still receives an operation, but normally needs no manual resume.

## Inspect the authoritative result

```text
coremind run coremind.yaml --prompt "run the task" --json-events
```

The final `run_result.snapshot` is the authoritative pure-JSON result for `runId`, operation, outcome, metrics, evaluation, trace, checkpoints, artifacts, extension receipts, and resumability. Compatibility fields at the top level must match it. Do not infer success from the natural-language summary alone.

## Continue a paused or interrupted run

```text
coremind run coremind.yaml --resume <runId> --json-events
```

Automatic resume stops for a changed configuration fingerprint, a terminal operation, an unknown effect receipt, a committed effect outside a stable completed step, or corrupt RunState.

## Legacy sessions

The framework creates `.v3.backup` before migration. Supported messages, model changes, active tool changes, compactions, branch summaries, labels, and names migrate. An entry that cannot be represented losslessly returns an explicit error and preserves the source. Follow the [SOP](SOP.en.md) to retain the old version or export its effective context.

## Common beginner mistakes

- Treating `paused` as permission to retry blindly.
- Assuming an external effect succeeded merely because a local file changed.
- Deleting a lock without proving that its writer is gone.
- Backing up only the new file and losing the automatic legacy backup.
- Rerunning a new prompt after terminal closure and duplicating a non-idempotent tool call.

Run the [module example](../../../examples/modules/recover-durable-runs/README.en.md) before adapting recovery to a business workflow.
