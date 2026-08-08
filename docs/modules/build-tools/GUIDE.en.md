# Tools and Business Capabilities Guide

## When to use it

Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.

## Minimal example

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/build-tools/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
