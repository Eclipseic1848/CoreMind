# Skill and SOP Loading Guide

## When to use it

Package reusable procedures as concise skills and inject them per agent while keeping business facts in project documentation.

## Minimal example

```text
agents:
  reviewer:
    systemPrompt: 你是代码审查助手
    skills:
      - code-review
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/package-agent-skills/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
