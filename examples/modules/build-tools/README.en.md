# Tools and Business Capabilities Example

## Register one application tool

Prepare the [Runtime-only configuration](../../../docs/en/guide/06-capability-construction.md) in your project and run `npm install --save-exact coremind-ai@2.1.0` to install the TypeScript SDK. Copy [single-tool.mts](single-tool.mts) and [order-lookup.mjs](order-lookup.mjs) and run `node single-tool.mts order-lookup.mjs`. The host registers one tool. When called it returns the order ID, status and implementation version. Pass the new implementation file to upgrade or the original file to roll back. Omit the implementation argument to remove the tool registration. Set allow or deny rules for `lookup_order` in the host configuration. The Runtime validates the input schema and observes the result.

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

To try the built-in read tool, use the [single-tool configuration](../../../docs/modules/build-tools/GUIDE.en.md) in your own directory. The `transport-parity.mjs` runner and its loopback services are source-based acceptance examples. The optional browser scenario uses the Playwright MCP service and browser specified in its guide. Ordinary file tools can run independently.

## Run the three local tool entry points

```sh
npm run build
node examples/modules/build-tools/transport-parity.mjs
```

A deterministic model fixture calls the local handler, real stdio MCP, and loopback Streamable HTTP MCP. Each entry point should return `{"flag":false,"count":0,"empty":null}`. The script checks connection, tool discovery, and echo approvals for both MCP transports, and closes the local services. [Optional browser example](../../../docs/modules/build-tools/BROWSER.en.md)

## Verify write receipts across three entry points

Build from the current source and run the following command. It compares one synthetic write across the three entry points with a valid receipt, a missing required field, a wrong field type, and a receipt lost after the write. The example uses a deterministic model fixture and dedicated local MCP services.

```sh
npm run build
node examples/modules/build-tools/write-receipts.mjs --output .scratch/issue-438/write-receipts.json
```

The JSON report records model calls, actual business writes, effect status, and cold-recovery results for 12 cases. Each entry point should report `committed` for a valid receipt and `unknown` for an incomplete or lost receipt. Verify that every `unknown` case prevents another write during the Run and on cold recovery. When applying the schema to an application tool, use its business request ID to reconcile the actual state. [Development SOP](../../../docs/modules/build-tools/SOP.en.md#verify-write-receipts-and-unknown-effects)

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
