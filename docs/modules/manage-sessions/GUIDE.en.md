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

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/manage-sessions/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Inject one compaction failure, confirm messages remain and `context_compaction_failed` is emitted, then inspect all six mandatory summary sections.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
