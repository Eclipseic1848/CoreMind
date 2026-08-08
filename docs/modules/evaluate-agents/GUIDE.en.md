# Testing, Evaluation, and Quality Gates Guide

## When to use it

Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes.

## Minimal example

```text
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      contains:
        - 已支付
      notContains:
        - TODO
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/evaluate-agents/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
