# Trace, RunState, and Debugging Guide

## When to use it

Preserve reviewable evidence through events carrying runId, eventId, sequence, and timestamp plus append-only RunState, and derive safe resume plans.

## Minimal example

```text
runtime = await CoreMindRuntime.create({
  config,
  configDir,
  trace: (entry) => console.log(entry.sequence, entry.event.type),
});
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/inspect-agent-traces/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. For an explicit Loop, verify ordered `loop_state` events, the latest stable snapshot, and every started, committed, or unknown effect receipt.
6. Run one tool with test-only fake credentials and body content, then confirm Trace and RunState retain only redaction markers, target paths, and non-sensitive audit data.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not disable trace redaction for debugging. Inspect raw business data separately under the business system's own access controls.
