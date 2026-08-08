# Agent Construction Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
agents:
  main:
    systemPrompt: |
      只根据订单工具返回的数据回答；缺失信息时明确说明。
    tools:
      - id: read
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.

Return to the [English guide](../../../docs/modules/design-agents/GUIDE.en.md).
