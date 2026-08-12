# Templates and Project Guidance Guide

## When to use it

Generate language-aware code skeletons, tests, evaluations, bilingual documentation, SOPs, and a project skill without overwriting existing files.

## Minimal example

```text
coremind create . --template customer-triage
# 混合或空工程：
coremind create . --template customer-triage --language python --provider alibaba-model-studio
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/scaffold-coremind-projects/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
