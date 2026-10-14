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
5. With a separate test tool declaring `pathFields` or `urlFields`, pass an outside `../secret.txt` path or forbidden URL and confirm workspace or network policy rejects it before execution. The `lookup_order` above has only an `id` parameter and does not test paths or URLs.
6. Temporarily rename the tool to `read` and confirm definition or registration rejects it before execution; then restore a business-specific name.
7. Run the ProcessRunner, GitAdapter, and unified-diff tests; confirm timeout, cancellation, output limits, read-only Git, and oversized files all fail closed.

## Local MCP verification

Use the [full configuration](../../../docs/en/guide/02-configuration.md#agent-scoped-local-mcp-tools) with an audited local stdio program. Run `coremind doctor coremind.yaml` and verify it starts no service, then `coremind run coremind.yaml --prompt "Call the approved tool"`. Approve connection, listing, and business execution separately. Inspect three independent Calls/EffectReceipts, the actual raw tool arguments, and process exit after completion.

Safe defaults must reject startup. The explicit trusted-host example opens workspace and network authority, so the existing `coremind check` workspace gate must fail; it does not qualify as a constrained-project release. Run the repository's real MCP regressions before integrating your program. Those offline regressions require no real model credentials.

Return to the [English guide](../../../docs/modules/build-tools/GUIDE.en.md).
