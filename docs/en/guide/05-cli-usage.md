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

Use `npx coremind-cli@1.3.0` before global installation, or invoke `coremind` after installing `coremind-cli@1.3.0` globally. Releases and registries are the source of truth for public availability and later versions.

## Recommended first run

```bash
npx coremind-cli@1.3.0 doctor
npx coremind-cli@1.3.0 check coremind.yaml
npx coremind-cli@1.3.0 run coremind.yaml --dry-run
npx coremind-cli@1.3.0 chat coremind.yaml
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

Stable exit codes are `0` succeeded, `1` failed, `2` paused, `3` budget exhausted, `124` timed out, and `130` aborted. With `--json-events`, stdout is JSONL, ordered `loop_state` events expose explicit Loop progress, and successful delivery ends with `run_result`; diagnostics go to stderr. `run_result.observability` is the same Fact Projection used by TypeScript, Python, and Worker consumers. Local Run, Context, Call, error, and delivery state remains available when Telemetry is `DISABLED`. `--print` stdout contains only the final body; notices, approvals, and diagnostics use stderr. `--print` and `--json-events` are mutually exclusive.

When a model reaches its per-response output limit (`stopReason: length`), the Run returns `failed/model_output_limit` and exit code `1`. The result preserves the partial body and original message stop reason; `--print` still outputs that partial body. It must not be treated as a complete answer. Runtime does not automatically continue or retry it as a transient failure, and does not advance later Workflow steps or Loop verification. This differs from the cumulative Run budget error `budget_exceeded`.

## `chat`

Starts the terminal interface with streaming output, approval requests, current Loop state, session controls, and trace visibility. Use `ask` mode while learning or reviewing a new repository.

Use `/status` for the terminal summary, `/children` for the expanded Child Run tree, `/artifacts` for stored or blocked artifacts, `/context` for budget and compaction state, and `/observability` for local observation and Telemetry status. The default summary highlights Child Run count, active descendants, and unhandled risk; `/children` can also query current canonical Facts while a run is active. `/children` reads only the unified Fact Projection and shows nested identities, targets, budgets, status, Outcome, Recovery, and risk text; it does not expose standalone spawn/list/resume/detach paths. Delegation approval cards prioritize the target, bounded task summary, explicit references, and tightened budget, and explicitly authorize only Child Run creation rather than child tool or external Effects. The currently available cancellation authority is `/abort`: it aborts the active parent response and Runtime propagates cancellation to active Child Runs. Unsupported child-specific cancellation or failure-disposition controls are not displayed or simulated.

The observation view includes Run/Call timing, mode, redacted endpoint origin, content level, allowed fields, persisted authorization scopes, Exporter loading, and queued/handed-off/failed/dropped counts. `handed-off` means passed to the Exporter, not stored by the receiver. The default `DISABLED` mode neither reads egress credentials nor constructs an Exporter.

The 1.1 development line adds `/steer text` and `/follow-up text` to both TUI and readline (`--no-tui`). Steering enters a later available Turn; follow-up waits until the agent would naturally stop, within the same Run. Neither starts a concurrent Run nor changes permissions, Provider, or budgets. Empty commands show usage. Missing, unready, or sealed active Runs reject controls rather than retaining them for a later Run.

During tool approval, readline recognizes explicit control commands before approval answers. In TUI, `/` enters a separate command mode: Enter submits and Esc returns to approval. Letters y/n inside commands cannot approve a tool. Ordinary approval still uses y to allow and n/Enter/Esc to deny; non-TTY approval denies safely. Controls do not grant permissions, and full mode retains existing deny rules. Additional input is rejected while independent host verification waits, so it cannot change the candidate under review.

Ordinary busy input remains one draft and never runs automatically or becomes a control. TUI retains its editable buffer until Enter is pressed again after the Run becomes idle. Readline keeps the first submitted busy draft and reports later submissions as unsaved without overwriting it. Once idle, a terminal can prefill the draft for editing and Enter confirmation; without prefill, a blank line confirms the saved draft. A late control receipt displays its original Run/controlId without clearing a newer draft.

Control receipts are `accepted`, `applied`, `rejected`, `duplicate`, or `conflict`. Accepted means durably received; applied means the applied fact committed before delivery to the agent queue. Neither proves model consumption. Separate `input_receipt`, `input_claimed`, `input_completed`, and `input_discarded` events show input identity and lifecycle. Check the Run outcome for business completion.

On cold recovery, accepted controls apply with their original identity once the agent is ready. Applied controls without confirmed consumption are discarded explicitly instead of automatically redelivered. The durable-commit/in-memory-delivery crash window remains; this is not an absolute exactly-once guarantee. Paused original inputs retain their existing recovery path, while discarded ordinary inputs still block recovery. A discarded control does not invalidate an otherwise resumable pause. Control facts do not replace Session messages or expand full-conversation reconstruction.

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

On the 1.1 development line, tool rows use the current Run, Agent, optional Step, and callId as their identity. Matching names, arguments, or argument fingerprints cannot identify a call. Approval requests may carry callId/stepId; decisions still link through Run and approvalId. Legacy requests without call identity appear as separate approval records explicitly marked as unbound. Approval waits, denial, execution phases, results, and effects remain distinct. Missing execution duration is shown as unrecorded; locally observed waiting is not execution time. Ending a Run does not turn a missing tool result into success or cancellation.

The optional second argument of `ChatSession.onEvent` reuses the original Trace entry, retaining the event's own Run, eventId, and sequence. Existing single-argument listeners remain compatible; a missing source never implies a Run identity.

Artifacts show their actual stored/blocked state and controlled references. Blocked items have no openable path, and the interface does not read or open arbitrary output paths. Loading Skill instructions does not change permissions. Tool discovery preparation and the catalog actually used by a Provider request are displayed separately. Installed tools become available in subsequent requests and retain the existing approval checks.

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

### Pipe output delivery limits

Application output from `run` and readline chat uses a bounded delivery queue. Encoded UTF-8 queued and in-flight data together are limited to **64 MiB and 1024 messages**; one message cannot exceed 64 MiB. Completion waits for each write callback and, when write returns false, drain as well. Final flush has a **10-second** deadline. These are transport limits, not the Runtime token budget, a total memory bound, or model-stream backpressure. JSON encoding, external Writable buffers, Ink rendering, and readline TTY editing echoes are outside this queue.

The CLI does not drop body text, control receipts, or final results. Overflow, a broken pipe, a stream error, or a flush timeout latches `output_delivery_failed`, requests cancellation of the active Run, and waits for its existing cleanup. The command exits with `1`; delivery failure is not user cancellation `130`. Normal backpressure does not pause readline `/abort` or approval input. After a hard budget failure, another receipt cannot be guaranteed. Only successfully delivered `--json-events` output guarantees a final `run_result`; a missing or partial final record is not success. Transport failure neither rewrites persisted Run Facts nor automatically replays potentially effectful work.

The 10-second limit bounds delivery waiting, not forced termination of a physical stream or uncooperative JavaScript. Logical close returns without an unbounded wait; an outstanding owned write retains only one error guard and its close cleanup listener until that callback or stream close settles. A timeout is not proof that all accepted operations are quiescent; related resources must not be released or reused on that assumption.
