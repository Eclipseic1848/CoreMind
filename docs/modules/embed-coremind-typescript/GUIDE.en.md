# TypeScript SDK Guide

## When to use it

Embed runtime, tools, sessions, explicit Loops, evaluation, and events in Node applications through the single coremind-ai facade.

## Minimal example

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
console.log(result.snapshot.operation, result.snapshot.artifacts);
if (result.outcome.status !== 'succeeded') {
  console.error(result.outcome.error?.message ?? result.outcome.finishReason);
}
```

Create `lookupOrder` with `defineTool` and a truthful declaration such as `effect: { operations: ['read'], reversible: true }`. Normal run terminal states are returned, while `catch` remains for configuration loading, runtime creation, or caller-side failures.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/embed-coremind-typescript/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Add caller-branch tests for `failed`, `paused`, `aborted`, `timeout`, and `budget_exceeded`.
6. With `config.loop`, collect ordered `loop_state` events and verify resume does not replay completed steps or committed effects.
7. Send `result.snapshot` across boundaries instead of directly serializing the `outputs` or `messages` maps.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
