# CLI Reference

The CLI provides project scaffolding, environment checks, static validation, interactive chat, one-shot execution, evaluation, and template discovery.

## Commands

```bash
coremind create <directory>
coremind doctor
coremind check [config]
coremind run [config] [prompt]
coremind chat [config]
coremind eval [config]
coremind list-templates
coremind providers
```

Use `npx coremind-cli@0.7.0` before global installation, or invoke `coremind` after installing `coremind-cli@0.7.0` globally. The stable release is published; use Releases and registries as the source of truth for later versions.

## Recommended first run

```bash
npx coremind-cli@0.7.0 doctor
npx coremind-cli@0.7.0 check coremind.yaml
npx coremind-cli@0.7.0 run coremind.yaml --dry-run
npx coremind-cli@0.7.0 chat coremind.yaml
```

This sequence separates environment, configuration, resolution, and live execution failures.

## `create`

Creates a project from a maintained template. The wizard asks for language, provider, and permission mode, then writes the configuration, environment sample, tests, and local guidance. Non-interactive execution requires `--provider`; optional `--model` and `--api-key-env` values refine the selection. Existing non-empty targets are rejected unless the command explicitly supports safe reuse.

## `providers`

Lists every configurable provider and separates current certification evidence from catalog-only support. Use it before `create`; configurability alone is not a live certification claim.

## `doctor`

Checks Node.js, configuration visibility, credentials, platform capabilities, and common installation problems. Without a config it summarizes common keys; with a config it checks that config's `provider.apiKeyEnv` or supported default instead of requiring unrelated Provider keys. A successful result confirms prerequisites, not live provider behavior.

## `check`

Validates configuration and project contracts without contacting a model. Use it in local hooks and CI.

## `run`

Executes a single request and exits with a structured result. Use `--dry-run` to inspect resolved settings without model traffic. Use `--resume <runId>` to continue a paused or interrupted run from a persisted stable boundary. Automation should consume documented result fields and the process exit code rather than decorative terminal text.

Stable exit codes are `0` succeeded, `1` failed, `2` paused, `3` budget exhausted, `124` timed out, and `130` aborted. With `--json-events`, stdout is JSONL, ordered `loop_state` events expose explicit Loop progress, and the last record is always `run_result`; diagnostics go to stderr. `run_result.observability` is the same Fact Projection used by TypeScript, Python, and Worker consumers. Local Run, Context, Call, error, and delivery state remains available when Telemetry is `DISABLED`. `--print` and `--json-events` are mutually exclusive.

## `chat`

Starts the terminal interface with streaming output, approval requests, current Loop state, session controls, and trace visibility. Use `ask` mode while learning or reviewing a new repository.

Use `/status` for the terminal summary, `/children` for the expanded Child Run tree, `/artifacts` for stored or blocked artifacts, `/context` for budget and compaction state, and `/observability` for local observation and Telemetry status. The default summary highlights Child Run count, active descendants, and unhandled risk; `/children` can also query current canonical Facts while a run is active. `/children` reads only the unified Fact Projection and shows nested identities, targets, budgets, status, Outcome, Recovery, and risk text; it does not expose standalone spawn/list/resume/detach paths. Delegation approval cards prioritize the target, bounded task summary, explicit references, and tightened budget, and explicitly authorize only Child Run creation rather than child tool or external Effects. The currently available cancellation authority is `/abort`: it aborts the active parent response and Runtime propagates cancellation to active Child Runs. Unsupported child-specific cancellation or failure-disposition controls are not displayed or simulated.

The observation view includes Run/Call timing, mode, redacted endpoint origin, content level, allowed fields, persisted authorization scopes, Exporter loading, and queued/handed-off/failed/dropped counts. `handed-off` means passed to the Exporter, not stored by the receiver. The default `DISABLED` mode neither reads egress credentials nor constructs an Exporter.

Use `/abort` to stop the active response. To persist a named session, enable it in `coremind.yaml` before passing `--session`:

```yaml
session:
  enabled: true
  dir: ./sessions
```

```bash
coremind chat coremind.yaml --session work-1
```

Both `chat` and `run` fail with a configuration hint if `--session` is provided without `session.enabled: true`; the session identifier is never silently ignored.

Approval panels show effects, complete paths or URLs, risk reasons, and redacted arguments. Tool execution records started, committed, or unknown effect receipts. Checkpoint restore refuses to overwrite a file changed after the tool completed. Resume does not replay committed effects and pauses for human reconciliation of unknown effects. On Windows, host shell execution requires full mode, `workspaceOnly: false`, and `network: allow`; every other combination is denied. Git Bash discovery provides compatibility, not isolation.

## `eval`

Runs declared evaluation cases and reports gate results. schemaVersion 1 supports compatible text assertions; schemaVersion 2 adds outcome, trajectory, command, file, diff, state, and response graders. Coding tasks should use the second form to prove target and regression tests, allowed files, dirty-worktree preservation, and final evidence.

```powershell
coremind eval coremind.yaml --suite evals/scenarios.yaml --json
```

See the [Coding Agent guide](../../modules/build-coding-agents/GUIDE.en.md) and [real-defect evaluations](../../../examples/coding-evals/README.en.md). Keep evaluation datasets free of secrets and record provider/model versions for reproducibility.

## Troubleshooting order

1. Run `doctor`.
2. Run `check` on the exact configuration path.
3. Run with `--dry-run`.
4. Inspect the structured error and trace identifier.
5. Reproduce with the smallest configuration before reporting an issue.

When filing a bug, include the CoreMind version, operating system, Node.js version, command, redacted configuration, expected behavior, actual behavior, and a minimal reproduction. Never include API keys.
