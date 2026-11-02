# Sessions and Context Guide

## When to use it

Persist multi-turn messages, fail clearly on corrupt recovery, and protect context deterministically before provider calls.

## Minimal example

```text
session:
  enabled: true
  dir: ./.coremind/sessions
  compact: false
```

The CLI accepts `--session <id>` only after sessions are enabled. Otherwise it fails clearly with configuration guidance.

Reopening the same physical workspace through Windows long/short paths or directory links checks directory and public-file identity and retains the existing v4 storage path from its header. History stays in place. A different physical directory or an identical-content copy with a different file identity cannot use this recovery path.

`session.compact` controls the legacy `ContextProtector`; it does not disable the Runtime's model-aware request budget. Whenever a request exceeds available input space, the Runtime attempts to build a bounded working set. If this actually requires compaction, an enabled writable session must exist because the summary cannot live only in process memory.

Models may expose different context windows and output limits. The Runtime resolves capabilities again for every request and model switch, and budgets the request's exact `maxTokens`; it does not silently shrink the caller's request to a fraction of the context window.

## TypeScript session trees (1.4 release line)

Import ChatSession, CoreMindRuntime and the ChatSessionNodeRef/ChatSessionTree types from coremind-ai. Enable persistent sessions and provide sessionId in trusted host options. See the [runnable example](../../../examples/modules/manage-sessions/branches.mjs).

```ts
const chat = new ChatSession(await CoreMindRuntime.create(options), "main");
await chat.chat("First question");
const tree = await chat.inspectSessionTree();
const entry = tree.nodes.filter((node) => node.type === "message").at(-1)!;
const at = { sessionId: tree.sessionId, entryId: entry.id };
await chat.createBranch("alternative", at);
await chat.selectBranch("alternative");
await chat.chat("Continue this branch");
const fork = await chat.fork(at);
const forkChat = new ChatSession(await CoreMindRuntime.create({
  config: options.config, configDir: options.configDir, cwd: options.cwd,
  sessionId: fork.sessionId,
}), "main");
await forkChat.chat("Continue the new session");
```

- createBranch(id, at) starts at a message, or empty history when at is null. Names use 1–64 letters, digits, hyphens or underscores. Creation does not select; main is the initial branch.
- selectBranch(id) persists one selection for the entire Session. Later chat reads and appends only that branch. Stale Chat objects reject until reopened through a fresh Runtime.
- inspectSessionTree() returns a detached sessionId/activeBranch/branches/nodes/forkedFrom? snapshot. Nodes include the entire tree and unredacted messages; host access control is required. Node references bind sessionId even when historical entry ids match across forks.
- fork(at) includes the message and ancestors, generates a new identity and leaves source bytes unchanged. No target id/path is accepted. Reapply host policy and credentials explicitly; do not copy runId/resumeRunId/protocolStart. Runs, unconsumed controls, execution receipts, checkpoints and credential grants are not copied. Historical tool ids do not grant authority.
- Navigation requires persistence, the main Agent and no active Run/navigation/writer. Query also requires idle ownership and may perform existing open-time repairs. Invalid input uses session_navigation_invalid; concurrency uses concurrent_run/session_write_locked; stale history uses session_snapshot_stale.
- Each chat creates a fresh Run/Agent. Runtime persists at settlement; persist() only returns the most recent turn's path.

A rejected selection write may already be durable: preserve files and reopen to inspect rather than assuming rollback. A failed fork alias may leave a complete internal candidate; verify its identity from the reported path before opening, without blindly forking again or deleting the source.

Old v3 and unbranched v4 data remain compatible. Older SDKs ignore persisted selection and must not take over new files. Rollback requires stopping writers, preserving Session/Run/Workspace and restoring pre-upgrade backups. These APIs neither implement upstream ExtensionAPI nor resume an old Run. See the [cross-language guide](../embed-coremind-python/GUIDE.en.md) for Python/RPC navigation. See [ADR0029](../../adr/0029-public-session-tree-navigation.md).

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/manage-sessions/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Inject a legacy protector failure and confirm messages remain with `context_compaction_failed`. Then inject an unknown capability, sessionless compaction, artifact drift, and corrupt lineage for the model-aware lifecycle; require `context_lifecycle_failed` and zero provider calls.
6. Repeat a long task with at least two configured model windows. Inspect `context_budget_resolved` for source, confidence, the exact output reserve, and every input-cost component.
7. After compaction, verify all six mandatory summary sections, the previous complete turn, the active user message, the session-entry reference, and the ledger parent chain. At the depth limit, require a rebuild from canonical session messages.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not present estimated tokens as an absolute provider truth. The safety margin and a single pause on provider overflow handle boundary error; retrying the same request is not allowed.
- Do not depend on an in-memory summary for a long task with sessions disabled. The Runtime pauses when compaction is required.
- Do not describe inherited providers as genuinely certified.
