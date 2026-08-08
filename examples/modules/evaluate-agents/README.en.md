# Testing, Evaluation, and Quality Gates Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

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

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/evaluate-agents/GUIDE.en.md).
