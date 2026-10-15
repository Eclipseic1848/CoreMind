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

## HTTP MCP resource verification

Use the [HTTP configuration fragment](../../../docs/en/guide/02-configuration.md#controlled-http-mcp-and-exact-resource-authorization). Replace `https://mcp.example.com/mcp` with your audited fixed endpoint and `fixture://first` with a complete resource URI that service actually provides and this agent may read. Set `MCP_AUTHORIZATION` to the complete `Bearer <service-token>` Header value instead of placing a token in YAML. The fragment is not a callable public demonstration service.

Use `http://127.0.0.1:8765/mcp` with `allowedAddresses: ['127.0.0.1']` only for your local HTTP fixture. Default public HTTPS permits verified public addresses. A nonempty allowlist constrains every resolved endpoint address rather than adding exceptions. URLs omit query, userinfo, and fragment; all redirects are rejected, environment proxies are ignored, and static `doctor` never connects.

1. Select only resources without selecting or inheriting MCP tools. Confirm zero service requests before the first model request and a handshake only after an explicit resource call. Tool-only selection must not list resources.
2. Call list, templates, and exact read. Missing/empty `mcpResources` inherits nothing. Guessed URIs, template expansions outside scope, and unauthorized response URIs must fail. Never read host `file:` content, follow links, execute HTML, or accept blobs.
3. With `network: allow`, verify configuration approval of network operations even under `mode: ask`; separately cover the existing approval with `network: ask` and zero sends under deny. Keep truthful business `external` effects and workspace hard gates rather than changing declarations to obtain authority.
4. Use repository HTTP regressions for pagination, 8 MiB bodies/64 MiB owners, 32 pages/256 entries, 30-second total deadlines, and at most three recovery GETs in 30 seconds. Cancelled resource requests must preserve other authorized calls; lost write responses must not resend business POSTs. Run shutdown closes local bodies/sockets/the dispatcher, sends no DELETE, and relies on service leases for remote sessions.
5. Cover TS, CLI, and Python sync/async success, missing credentials, 401/403, and cancellation after sending. Credentials must stay out of model input, Facts, Artifacts, and Worker JSON. A 401/403 never starts OAuth or refresh. Old Workers reject unsupported configuration, and Child Runs inherit no MCP/resources/credentials.

These steps define acceptance methods rather than claiming all tests, installed artifacts, or real external interoperability have passed. Preserve separate evidence for each executed form.

Return to the [English guide](../../../docs/modules/build-tools/GUIDE.en.md).
