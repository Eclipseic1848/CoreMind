# TypeScript SDK Guide

## When to use it

Embed runtime, tools, sessions, evaluation, and events in Node applications through the single coremind-ai facade.

## Minimal example

```text
const runtime = await CoreMindRuntime.create({
  config,
  configDir: process.cwd(),
  initialPrompt: '执行任务',
  toolDefinitions: [lookupOrder],
});
const result = await runtime.run();
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/embed-coremind-typescript/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
