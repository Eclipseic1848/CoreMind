# CLI and TUI Guide

## When to use it

Provide a beginner end-to-end path through create, run, chat, check, eval, doctor, and templates, with run --resume for unfinished runs that have a safe recovery boundary.

## Minimal example

```text
coremind create my-agent --template translator --language typescript
coremind check my-agent/coremind.yaml
coremind eval my-agent/coremind.yaml
```

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/operate-coremind-cli/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
