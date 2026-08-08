# Workflows and Bounded Loops Guide

## When to use it

Compose agents with sequence, parallelism, conditions, and bounded retries, enforce a global loop budget, and resume safely from persisted stable step boundaries.

## Minimal example

```text
workflow:
  - id: draft
    type: call
    agent: writer
    input: '{{prompt}}'
    saveAs: draft
  - id: review
    type: call
    agent: reviewer
    input: '{{draft.text}}'
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/design-workflows/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
