# Configuration and Schema Guide

## When to use it

Describe agents, tools, a Workflow or explicit Loop, budgets, permissions, and quality profiles in one validated coremind.yaml file.

## Minimal example

```text
schemaVersion: 2
name: support-agent
agents:
  main:
    systemPrompt: 你是客服助手
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 12
quality:
  profile: standard
```

Custom script tools must also declare inspectable effects:

```yaml
agents:
  main:
    tools:
      - path: tools/save-report.mjs
        effect:
          operations: [write]
          reversible: true
          pathFields: [output.path]
```

`pathFields` and `urlFields` accept dotted paths and must identify real fields in tool-call arguments. Never mark an external, non-reversible operation as `reversible: true`. Custom tools must not reuse built-in names such as `read`, `write`, or `bash`.

For independent verification and bounded repair, add `loop.execute`, `loop.verify.passIf`, `loop.repair`, and every boundary field. Do not configure `workflow` at the same time. See the [explicit Loop guide](../design-workflows/GUIDE.en.md).

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/configure-coremind/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. For a Loop, run the verified repair golden example and cover pause-resume plus exhaustion failure.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, effect receipts, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not omit or invent a custom tool's `effect`; first split the tool boundary when its effects cannot be described precisely.
