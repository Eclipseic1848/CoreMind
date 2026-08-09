# Tools and Business Capabilities Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. Try a nested `../secret.txt` path or URL and confirm workspace or network policy rejects it before execution.
6. Temporarily rename the tool to `read` and confirm definition or registration rejects it before execution; then restore a business-specific name.
7. Run the ProcessRunner, GitAdapter, and unified-diff tests; confirm timeout, cancellation, output limits, read-only Git, and oversized files all fail closed.

Return to the [English guide](../../../docs/modules/build-tools/GUIDE.en.md).
