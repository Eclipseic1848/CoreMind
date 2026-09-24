# Providers and Models Guide

## When to use it

Inherit the provider catalog from the locked runtime dependency while keeping availability separate from real certification.

## Minimal example

```text
provider:
  id: alibaba-model-studio
  model: qwen-plus
  apiKeyEnv: DASHSCOPE_API_KEY
```

This is the provider/model pair certified in the `0.8.0` release candidate; reverify it with your credentials and deployment environment. See the [module overview](README.en.md) for the difference between Candidate evidence and the static matrix.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/manage-providers/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. To claim certified status, separately follow the [seven-check live certification SOP](../../providers/CERTIFICATION.en.md). A successful `doctor` check is not certification.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not reuse older evidence that lacks abort or long-context checks. The matrix reports those gaps explicitly.

The `0.8.0` certification is historical only; `1.0.0` requires its own strict-provider workflow evidence.
