# Sessions and Context

Status: contract and documentation aligned with the `1.0.0` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls.

## Public interfaces

- `CoreMindSession`
- `ChatSession`
- `ChatSession.steer/followUp(message, options?)` (1.1 development; `options` is `{ controlId?, runId? }`)
- `ContextProtector`

`ContextLifecycleManager`, `ContextWorkingSetBuilder`, and `ContextTaskState` are available to controlled in-repository components through `coremind-runtime/internal`; they are not part of the main public entry point. Callers observe their results through Runtime events, `RunOutcome`, traces, and snapshots.

## Session write ownership

- A canonical directory and Session ID admit one active writer. A Run acquires a cross-process lease before reading execution history, covering model calls, tools, compaction, final appends, and cancellation convergence. Actual file operations use a separate short lock. Different sessions remain independent; file ownership does not grant tool permission.
- With `session.enabled` and a `sessionId`, `CoreMindRuntime.create()` opens or creates the empty session to capture a consistent preview and watermark. It holds no long lease and makes no model call. An ordinary `run()` refreshes history under its lease; Chat preserves its own compacted view and checks its source watermark.
- Competing writers receive `session_write_locked`. A stale holder or Chat receives `session_snapshot_stale` without changing the file or automatically merging branches. After an external Runtime advances the session, recreate the Runtime from persistent history before creating a Chat; creating a Chat on the old Runtime does not refresh external history. Normal consecutive turns in the same Chat carry the new watermark.
- Hosts managing history through `runAgentTurn` may retain the previous result messages or shallow-copy their array. When using JSON-reconstructed or deeply copied history across turns, recreate the Runtime from its persistent session to obtain a verifiable source watermark. Invalid writer identities report `session_write_lease_invalid`; corrupt locks or failed release require ownership review under `session_lock_recovery_required`. Reopen a holder after a reported write failure.
- After the final session write and execution convergence, CoreMind fences the old writer and releases its lease before forming the terminal result. Another Run may start while the preceding Run writes terminal metadata, after its model, tool, and session work has stopped. Unsafe convergence reports `session_not_quiescent` and retains ownership.
- Crash recovery requires a definitely dead recorded PID and a second matching owner/nonce check for each lock. Legacy empty locks, corrupt owners, and abandoned recovery claims fail closed and require ownership review; elapsed time never authorizes blind deletion. This mechanism targets local filesystems with hardlinks and does not promise shared-network-filesystem or power-loss durability.

## Model-aware lifecycle

- Every request resolves a context window and output limit for the actual provider/model route. Multiple trusted sources use their safe intersection; a custom endpoint without a trusted window uses a conservative value with explicit `assumed` evidence.
- When restored history changes model or provider, the request view omits the former model's thinking and retains its visible answer. The same model retains valid thinking fields. Filtering never deletes or rewrites the original persistent session facts.
- The input budget fully subtracts the request's actual `maxTokens`, stable prefix, tool schemas, structured output, multimodal occupancy, protocol overhead, and safety margin. An output request above the model limit, unknown image occupancy, or exhausted static budget fails closed before the provider call.
- When compaction is required, the working set replaces the old prefix with `TaskState` projected from Runtime facts, then retains the previous complete user-to-assistant turn and the active unfinished user message. If that undeletable set does not fit, the run pauses instead of truncating characters.
- Every compaction persists its summary and source range in the session and appends a fingerprint-only parent-linked ledger fact to the run facts. At the lineage-depth limit, CoreMind rebuilds from canonical session messages; it never guesses through a corrupt lineage.
- Controlled artifacts are revalidated for path, size, and SHA-256 before sending. A model switch causes a fresh budget resolution, and a provider-reported overflow does not blindly retry the same request.

## Errors and boundaries

- If the final JSON record cannot be parsed, recovery removes only the incomplete tail and preserves the validated UTF-8 prefix and public file identity. Reopening can continue appending. Corruption in the middle, invalid encoding in the complete prefix, and conflicting public paths still fail without silently overwriting data.

- session_restore_failed: stop on corruption instead of silently starting over
- Legacy `ContextProtector` failures emit `context_compaction_failed`. Model-aware lifecycle failures emit `context_lifecycle_failed` with `context_capability_conflict`, `context_budget_exhausted`, `context_artifact_missing`, or `context_lineage_corrupt`
- Model-aware compaction requires an enabled durable session. Without one, requests that fit may continue, but a request that needs compaction returns `paused` without calling the provider
- Successful resolution emits `context_budget_resolved`; successful compaction emits `context_compacted` with the capability fingerprint, lineage depth, trigger, and session-entry reference
- Summaries preserve goals, constraints, permissions, modified files, test status, and next steps
- Controls capture the current active Run. Unbound, unready, sealed, or mismatched Runs reject them without redirecting to a later Run. Retrying the same controlId within the same Run does not redeliver; conflicting content is reported explicitly
- The five control receipt states are separate from `input_*` consumption/discard facts. Applied does not mean consumed. Accepted controls can apply after cold recovery readiness; applied controls without confirmed consumption are explicitly discarded rather than automatically redelivered
- Paused original inputs retain existing recovery gates; discarded ordinary inputs remain non-resumable. A discarded control alone does not block a safe pause recovery, remove the crash window, or replace Session/compaction content. It does not establish full conversation recovery

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/session.ts](../../../packages/coremind-runtime/src/session.ts)
- [packages/coremind-runtime/src/chat-session.ts](../../../packages/coremind-runtime/src/chat-session.ts)
- [packages/coremind-runtime/src/context.ts](../../../packages/coremind-runtime/src/context.ts)
- [packages/coremind-runtime/src/context-lifecycle.ts](../../../packages/coremind-runtime/src/context-lifecycle.ts)
- [packages/coremind-runtime/src/context-task-state.ts](../../../packages/coremind-runtime/src/context-task-state.ts)
- [packages/coremind-runtime/src/session.test.ts](../../../packages/coremind-runtime/src/session.test.ts)
- [packages/coremind-runtime/src/chat-session.test.ts](../../../packages/coremind-runtime/src/chat-session.test.ts)
- [packages/coremind-runtime/src/context.test.ts](../../../packages/coremind-runtime/src/context.test.ts)
- [packages/coremind-runtime/src/context-lifecycle.test.ts](../../../packages/coremind-runtime/src/context-lifecycle.test.ts)
- [packages/coremind-runtime/src/context-task-state.test.ts](../../../packages/coremind-runtime/src/context-task-state.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [Real control recovery regressions](../../../packages/coremind-runtime/src/control-runtime.acceptance.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)
