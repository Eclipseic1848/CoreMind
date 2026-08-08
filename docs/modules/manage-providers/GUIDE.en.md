# Providers and Models Guide

## When to use it

Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.

## Minimal example

```text
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/manage-providers/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
