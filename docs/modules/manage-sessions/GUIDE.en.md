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

`session.compact` controls the legacy `ContextProtector`; it does not disable the Runtime's model-aware request budget. Whenever a request exceeds available input space, the Runtime attempts to build a bounded working set. If this actually requires compaction, an enabled writable session must exist because the summary cannot live only in process memory.

Models may expose different context windows and output limits. The Runtime resolves capabilities again for every request and model switch, and budgets the request's exact `maxTokens`; it does not silently shrink the caller's request to a fraction of the context window.

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
