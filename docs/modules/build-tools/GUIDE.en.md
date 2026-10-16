# Tools and Business Capabilities Guide

## When to use it

Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.

## Minimal example

```text
const lookupOrder = defineTool({
  name: 'lookup_order',
  description: '按编号查询模拟订单',
  parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  effect: { operations: ['read'], reversible: true },
  execute: async ({ id }) => ({ id, status: 'paid' }),
});
```

`operations` describes what the tool actually does, not its business name. Use `read` for data reads, `write` for file or record changes, `process` for subprocesses, `network` for HTTP access, and `external` when none of those are sufficient. Set `reversible: true` only when the framework can restore every side effect. Declare non-standard path or URL arguments with `pathFields` and `urlFields`, for example `pathFields: ['output.path']`.

Use a business-specific tool name rather than a reserved built-in name such as `read`, `write`, or `bash`. SDK definitions and script registration reject collisions before execution.

## Local MCP services

Use the [configuration guide](../../en/guide/02-configuration.md#agent-scoped-local-mcp-tools) to declare audited programs and exact per-agent raw tool references. CLI, TypeScript, and Python share the Node Runtime; Python does not create a second MCP client. Do not inject a remote catalog through global SDK `toolDefinitions`.

Run `coremind doctor coremind.yaml` for static diagnostics, then execute only with explicit `workspaceOnly: false` and `network: allow`. `ask` approves connection, listing, and business calls separately; explicit deny always wins. The two preparation operations consume tool budget. Declare complete, truthful Effect/Capability metadata. Trusted host code is not sandboxed; the existing project quality gate still rejects an unbounded workspace, and Child Runs inherit no MCP authority.

From the repository root run `npx vitest run packages/coremind-tools/src/mcp-stdio-client.test.ts packages/coremind-tools/src/mcp-stdio-transport.test.ts packages/coremind-runtime/src/mcp-runtime.acceptance.test.ts`. Verify zero corresponding I/O on denial, the first model schema, real process cleanup, blocked secret output, and no retry of unknown effects. Protocol errors and business `isError` remain distinct; retries cannot establish that an unproven write is safe.

Local Windows services continue to use system Windows PowerShell and a dedicated Job. Startup computes SHA-256 from the actual bundled DLL bytes and loads that same byte array. Normal installation and execution neither invoke a C# compiler nor import the PowerShell Utility module. Missing or mismatched assets reject startup without falling back to an uncontrolled process. The assembly uses the Windows-provided CLR 4 Framework family without a .NET SDK or NuGet. It does not sandbox trusted host code or guarantee startup within every system policy or load.

## Controlled HTTP MCP and resources

Use the [HTTP configuration](../../en/guide/02-configuration.md#controlled-http-mcp-and-exact-resource-authorization) with a fixed `streamable-http` URL without userinfo, query, or fragment. An environment reference in `headers.Authorization` must provide the complete value, including any `Bearer ` prefix. `secretRef` is also supported; never put tokens in configuration. Missing/unresolved credentials and 401/403 fail explicitly without OAuth, refresh, or identity fallback.

Without `allowedAddresses`, HTTPS permits only verified public addresses. A nonempty list constrains every endpoint address to exact IP literals, including public addresses; private addresses must be listed too. Plain HTTP requires a loopback IP literal URL and a matching allowlist entry. Verified DNS answers are pinned to actual sockets, TLS hostname checks remain enabled, all redirects are rejected, and environment proxies are ignored. Static `doctor` never connects.

HTTP connection, listing, and resource operations use existing network authorization. `network: allow` already approves them, including under `mode: ask`; `network: ask` retains network approval. Actual business `external` effects, explicit deny, and workspace hard gates remain. Child Runs inherit no MCP, resource, or credential authority.

Select complete URI strings per agent, for example `mcpResources: {remote: ['fixture://first']}`. Missing and empty sets grant and inherit nothing. Resources require HTTP. List, templates, and read are lazy; matching templates never expands read scope, and returned content URIs must also be authorized. A `file:` URI is not a host-file API; links/HTML are not dereferenced or executed, and blobs are unsupported. Resource-only agents without inherited MCP tools perform no HTTP I/O before the first model request; tool-only selection never implicitly lists resources.

Limits are 8 MiB per body, 64 MiB per owner, 32 pages/256 directory entries, and a 30-second total request/directory deadline. GET recovery allows at most three requests per owner in 30 seconds; business POSTs are never automatically resent. Cancelling one request must preserve other authorized calls. Run shutdown waits for local bodies/sockets/the dispatcher without sending remote DELETE; the service's lease owns remote session cleanup. Secrets must stay out of prompts, Facts, exceptions, and Worker JSON. Large safe results use the existing Artifact path.

Follow the HTTP fetch/transport/client, Runtime, CLI, and Python tests in [module.yaml](module.yaml) for allowed, denied, cancelled, and unknown-effect cases while preserving stdio regressions. These are execution and acceptance instructions, not a claim that all tests or real external service interoperability have passed.

## MCP authentication ownership (1.1 development line)

HTTP `oauth` is mutually exclusive with an Authorization Header. An explicit host session owns authentication; tools borrow a private binding without exposing tokens to models or protocol messages. Refresh is shared by complete serverIdentity with independently cancellable calls; only the last departing waiter aborts it. Logout revokes local use before late results can publish. HTTP 401 never resends a business POST. Secret checks follow current and in-flight old tokens through headers, chunks, parsed/joined results, and Artifacts.

See the [configuration guide](../../en/guide/02-configuration.md) for memory mode, explicit secure TokenStore, network authorization, supported services, and unverified external interoperability. TypeScript, CLI, and Python use one Node engine; tools must not open a browser or implicitly create sessions. Registered authentication tests cover full local authorization and rejection; fixtures are not external provider certification.

## Coding-tool boundaries

```ts
import { GitAdapter, ProcessRunner, diffFiles } from "coremind-ai";

const tests = await new ProcessRunner().run({
  command: process.execPath,
  args: ["--test"],
  cwd: process.cwd(),
  timeoutMs: 30_000,
  maxOutputBytes: 2 * 1024 * 1024,
});

const git = new GitAdapter({ cwd: process.cwd() });
const status = await git.status();
const patch = await git.diff();
const preview = await diffFiles("src/before.ts", "src/after.ts");
```

`ProcessRunner` takes a command and argument array rather than a concatenated string for shell interpretation. When explicit environment variables are needed, pass only the keys required by the task. That `env` is authoritative: it is not merged with the host environment or replaced by the tool execution context. Do not copy secrets into child processes by default. `GitAdapter` reads evidence and intentionally omits checkout, add, commit, reset, clean, and push. Unified diff is limited to bounded text files and fails explicitly when limits are exceeded.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/build-tools/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. Test nested path escape, network denial, repeated calls, and tool exceptions; confirm policy blocks before execution.
6. Test process timeout, cancellation, output limits, missing executables, Git link escape, and oversized diffs.
7. On Windows, cover Git Bash, the PowerShell fallback, and an explicit minimal environment; confirm the execution context cannot override the caller-supplied `env`.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
