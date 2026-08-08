# Agent Construction Guide

## When to use it

Build isolated agent instances from a focused system prompt, model options, tools, and skills.

## Minimal example

```text
agents:
  main:
    systemPrompt: |
      只根据订单工具返回的数据回答；缺失信息时明确说明。
    tools:
      - id: read
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/design-agents/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
