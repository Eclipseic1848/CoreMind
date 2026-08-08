# Source and Community Contribution Guide

## When to use it

Change CoreMind source within its one-way dependencies, test-first workflow, bilingual material contract, and release authorization boundary.

## Minimal example

```text
npm run build
npm run check
npm test
npm run docs:build
npm run release:preflight -- --allow-dirty
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/contribute-coremind/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
