# Sessions and Context

Status: published `0.3.1` stable release. This document also records the model-aware context-lifecycle contract in the current unreleased source. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls.

## Public interfaces

- `CoreMindSession`
- `ChatSession`
- `ContextProtector`

`ContextLifecycleManager`, `ContextWorkingSetBuilder`, and `ContextTaskState` are available to controlled in-repository components through `coremind-runtime/internal`; they are not part of the main public entry point. Callers observe their results through Runtime events, `RunOutcome`, traces, and snapshots.

## Model-aware lifecycle

- Every request resolves a context window and output limit for the actual provider/model route. Multiple trusted sources use their safe intersection; a custom endpoint without a trusted window uses a conservative value with explicit `assumed` evidence.
- The input budget fully subtracts the request's actual `maxTokens`, stable prefix, tool schemas, structured output, multimodal occupancy, protocol overhead, and safety margin. An output request above the model limit, unknown image occupancy, or exhausted static budget fails closed before the provider call.
- When compaction is required, the working set replaces the old prefix with `TaskState` projected from Runtime facts, then retains the previous complete user-to-assistant turn and the active unfinished user message. If that undeletable set does not fit, the run pauses instead of truncating characters.
- Every compaction persists its summary and source range in the session and appends a fingerprint-only parent-linked ledger fact to the run facts. At the lineage-depth limit, CoreMind rebuilds from canonical session messages; it never guesses through a corrupt lineage.
- Controlled artifacts are revalidated for path, size, and SHA-256 before sending. A model switch causes a fresh budget resolution, and a provider-reported overflow does not blindly retry the same request.

## Errors and boundaries

- session_restore_failed: stop on corruption instead of silently starting over
- Legacy `ContextProtector` failures emit `context_compaction_failed`. Model-aware lifecycle failures emit `context_lifecycle_failed` with `context_capability_conflict`, `context_budget_exhausted`, `context_artifact_missing`, or `context_lineage_corrupt`
- Model-aware compaction requires an enabled durable session. Without one, requests that fit may continue, but a request that needs compaction returns `paused` without calling the provider
- Successful resolution emits `context_budget_resolved`; successful compaction emits `context_compacted` with the capability fingerprint, lineage depth, trigger, and session-entry reference
- Summaries preserve goals, constraints, permissions, modified files, test status, and next steps

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
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/manage-sessions/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-sessions/README.en.md)
- [Agent Skill](../../../skills/manage-sessions/SKILL.md)
