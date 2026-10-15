# Configuration

`coremind.yaml` is the executable contract for one agent project. It describes intent, provider selection, tools, permissions, budgets, recovery, and quality requirements in one reviewable file.

## Minimal configuration

```yaml
schemaVersion: 2
name: my-agent
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
agents:
  main:
    systemPrompt: |
      Answer accurately. State uncertainty and never invent tool results.
    tools:
      - id: read
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
```

Keep the first configuration small. Add tools, workflow stages, or an explicit Loop only when a verified requirement needs them.

Providers are inherited dynamically from the locked runtime family. `0.2.0-rc.1` contains 37 inherited entries; releases from `0.3.0-rc.2` through the current `1.0.1` release line contain 39 inherited entries plus one CoreMind-native entry, for 40 configurable Providers. Use `listInheritedProviders()` to inspect the exact installed catalog. Configurability is not live certification; the checked-in ledger has no static `1.0.1` record, while formal publication also requires a same-version strict-provider workflow Artifact. Without real credentials and evidence for the current deployment, an entry remains configurable only.

Built-in tool IDs are `read`, `ls`, `find`, `grep`, `bash`, `edit`, `write`, `git_status`, `git_diff`, `git_log`, `web-fetch`, and `web-search`. The three Git tools are fixed read-only operations and never commit, switch, clean, or push a repository.

## Agent-scoped local MCP tools

Explicit stdio services start inside an authorized Run. Use absolute `command` and `cwd` paths and a fixed `args` array. CoreMind does not evaluate a shell or install programs. Replace these paths and the raw tool name with an audited local service:

```yaml
mcp:
  servers:
    local:
      transport: stdio
      command: /absolute/path/to/node
      args: [/absolute/path/to/server.mjs]
      cwd: /absolute/path/to/workspace
      env:
        SERVICE_TOKEN:
          env: LOCAL_SERVICE_TOKEN
agents:
  assistant:
    tools:
      - mcp:
          server: local
          tool: echo
        effect:
          operations: [external]
          reversible: false
        capability:
          effect: external
          replay: unknown
          concurrency: run_serial
          checkpoint: unsupported
          durability: critical
permissions:
  mode: ask
  workspaceOnly: false
  network: allow
```

On Windows, use absolute Windows paths; YAML single quotes preserve backslashes. Environment entries accept only `{env: NAME}` or `{secretRef: reference}`; SecretRef requires the embedding SDK's `secretResolver`. Only a finite set of platform variables and explicit references reach the service. Do not place secrets in configuration, arguments, or tool descriptions.

A nonempty agent `tools` list selects exact raw tools; omitted or empty lists inherit global `tools`. Internal aliases bind the server, raw name, full schema, and declared execution capability. Approval includes the actual command, directory, and identity digest. Connection, catalog listing, and each business call use the same approval, budget, lease, and durable-result chain. Connection plus listing consume two tool calls before business execution. The first model request retains the full selected schema, including `$defs/$ref`; server annotations never lower authority.

This is trusted host code with the current account's authority. Roots and tool allowlists provide no OS sandbox. `workspaceOnly: true` or `network: deny/ask` rejects startup even in `full` mode. `doctor` checks static conditions without starting or handshaking a service. The existing `coremind check` gate still rejects `workspaceOnly: false`; this configuration does not satisfy the constrained-project release baseline. Child Runs currently accept no MCP services, tools, or credentials.

The default `protocolVersion: legacy` performs no extra process probing. Set `2026-07-28` only for a service known to support it. Text and JSON values retain their meaning; large results become local Artifacts, and remote file paths never authorize host reads. Connections belong to this Run execution and close on completion or cancellation. Started process/external effects can be irreversible, so the existing cold-resume gate requires human review rather than automatically replaying them. An old Worker rejects selected MCP tool configuration; existing configurations without selected MCP retain their behavior.

## Controlled HTTP MCP and exact resource authorization

HTTP services use a fixed `streamable-http` endpoint. This resource-only configuration fragment requires an audited service URL and resource URI:

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      headers:
        Authorization:
          env: MCP_AUTHORIZATION
agents:
  assistant:
    mcpResources:
      remote: ['fixture://first']
permissions:
  mode: ask
  workspaceOnly: true
  network: allow
```

`MCP_AUTHORIZATION` must contain the complete Header value, such as `Bearer <service-token>`; CoreMind does not add `Bearer`. Use `{secretRef: reference}` with an SDK `secretResolver` when appropriate. Sensitive Headers reject literal credentials. Missing, blank, or unresolved references fail explicitly without falling back to anonymous access or another Provider's key. The URL must have no userinfo, query, or fragment. Credentials reach only the fixed endpoint and never enter model context, Facts, or Worker JSON. Header-mode 401/403 responses fail without starting login, refreshing tokens, or retrying business calls. Interactive services use the separate OAuth configuration below.

Public HTTPS allows verified public addresses by default. `allowedAddresses` is an exact IP-literal set for this endpoint; when present, every resolved address must match. Private addresses require explicit entries; CIDRs and hostnames are not accepted. Plain HTTP requires a loopback IP literal in both the URL and the allowlist:

```yaml
transport: streamable-http
url: http://127.0.0.1:8765/mcp
allowedAddresses: ['127.0.0.1']
```

`http://localhost` does not meet that boundary. Unspecified, multicast, link-local, and other invalid targets remain rejected even when listed. Each authorized connection verifies DNS answers and pins the actual socket address while preserving HTTPS hostname/TLS/SNI checks. All redirects are rejected, and host proxy environment variables are ignored. Static `doctor` performs no DNS lookup, network access, or handshake.

Select tools with the preceding section's exact `tools[].mcp` service/raw-name references and truthful Effect/Capability declarations. Tool and resource selection are independent. HTTP connection, tool listing, and resource operations use network authorization: `network: allow` is configuration approval even under `mode: ask`; `network: ask` retains the existing network approval, and explicit deny takes precedence. Business tools keep their actual `external` or other effects and existing workspace hard gates; the HTTP transport does not downgrade side effects to read-only network access.

`agent.mcpResources` matches complete URI strings exactly, without decoding, normalization, or prefix expansion. Omission, `{}`, and `remote: []` grant nothing and inherit nothing from global configuration, parents, or other agents. Resources currently require HTTP; stdio resources are explicitly unsupported. A nonempty set exposes list, templates, and read tools lazily. Lists contain authorized URIs; template matching only filters display and never broadens read access. Every returned content URI is checked too. Resource URIs go only to the fixed MCP endpoint: `file:`, links, and HTML trigger no host file reads, extra requests, or execution, and binary blobs are rejected.

Tool-only selection does not implicitly list resources. With only resources selected and no inherited MCP tools, the first model request occurs before any HTTP request; an explicit resource call establishes the connection. Operations retain the existing Run Harness, budgets, critical durability, and receipts. Child Runs inherit no MCP services, tools, resources, or credentials. HTTP/resource configuration requires a capable Worker; older Workers must reject it explicitly.

Each response body is limited to 8 MiB and each owner to 64 MiB total. Directories allow at most 32 pages and 256 entries, with a 30-second total request/directory deadline. GET recovery is bounded to three requests per owner within 30 seconds and never resends business POSTs. Cancelling one request preserves other authorized requests; Run shutdown waits for owned local bodies, sockets, and the dispatcher. No remote DELETE is sent, so remote session cleanup relies on the service's lease. Text/JSON and large Artifacts retain the existing result boundary; unknown remote writes are never replayed automatically.

## Explicit host-owned MCP authentication (1.1 development line)

HTTP services support Authorization Code with S256 and a preregistered public/native client. Replace that service's `headers.Authorization` with this configuration; both credential sources cannot coexist:

```yaml
mcp:
  servers:
    remote:
      transport: streamable-http
      url: https://mcp.example.com/mcp
      oauth:
        issuer: https://identity.example.com
        clientId: registered-native-client
        scopes: ['mcp:read']
```

Scopes are explicit and bounded, including an empty set; additional granted scopes are rejected. Resource metadata must bind the fixed resource and configured issuer. Authorization and Token endpoints must share the issuer's origin; cross-origin endpoints and redirects are rejected. MCP and issuer addresses are checked independently; use `oauth.allowedAddresses` for the issuer's own exact private-IP allowance. Plain HTTP still requires an explicitly allowed loopback IP. Dynamic client registration, client secrets, client credentials, and cross-origin authorization endpoints are unsupported.

`createMcpAuthentication({config})` performs no network I/O. Explicit `login(server, {onAuthorization, signal})` starts discovery and provides a URL for the user to open manually. No handler returns `mcp_auth_required` before discovery or callback creation. Network deny always wins; explicit login under ask approves only this fixed authentication transaction, leaving subsequent business policy unchanged. The 180-second login deadline starts before discovery. Node binds a random `127.0.0.1` port for a single callback with state, issuer, and PKCE validation.

Credentials stay in host memory by default and disappear on restart. One session can be injected into multiple Runtimes; each Run closes only its own connections. `logout(server)` revokes local use and deletes the stored record; `close()` cancels transactions and refresh, closes listeners, and clears memory while retaining explicitly persisted records. Neither calls a remote revocation endpoint. Node hosts may supply a secure `McpTokenStore` with a stable isolated `namespace`; the host owns atomic saves, bounded cancellation, and secure storage. No plaintext file is created by default, and SecretResolver remains read-only. Store failure returns `mcp_auth_store_failed` without falling back to an old credential.

Refresh is shared per complete server identity with independently cancellable waiters; the last cancellation stops the flight. Authorization and cancellation are checked before each request. A business POST is never resent after 401. Tokens, refresh state, and callback codes never enter model input, Facts, logs, Artifacts, or Worker messages. The standard authorization URL belongs only to temporary host interaction and should not be persisted.

See the [TypeScript guide](../../modules/embed-coremind-typescript/GUIDE.en.md). CLI supports `coremind run coremind.yaml --mcp-login remote --prompt 'Read resources'` in a human-output TTY, rejecting `--print` and `--json-events`. Chat uses `/mcp login remote`, `/mcp cancel`, and `/mcp logout remote`. [Python interaction](../../modules/embed-coremind-python/GUIDE.en.md) requires explicit Protocol v2 and `mcp_auth_handler`. Default v1, old Workers, and missing negotiated capability reject interaction explicitly.

The complete chain is tested with a local real HTTP authorization-server fixture. External-service interoperability remains unverified; this is not external provider certification. The user's browser must reach Node's callback; remote-container browser callback deployment is unverified.

## Environment substitution

Secrets belong in environment variables, not YAML:

```yaml
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
```

Validation reports a missing variable before execution. Do not place fallback secrets in the file.

Credentials may also use the backend-neutral
`apiKeySecretRef: { secretRef: "opaque-id" }`. An embedding host supplies a
`SecretResolver`; the CLI, Python SDK, and standard Worker do not, so SecretRef
configuration fails closed with `secret_reference_unresolved` and never falls
back to plaintext or another credential source. An explicitly configured but
empty `apiKeyEnv` fails the same way.

Ordinary custom headers may remain literal. Authorization,
Proxy-Authorization, X-API-Key, API-Key, X-Auth-Token, X-Access-Token,
X-Goog-API-Key, X-Amz-Security-Token, and Cookie values must use `{ env: "NAME" }` or
`{ secretRef: "opaque-id" }`. References and resolved values are excluded from
logs, errors, Facts, and persistence. Plaintext credentials fail with
`execution_security_violation` at check and every execution entry point.

## Config-driven Child Run delegation

Delegation is disabled by default. A parent agent exposes the built-in `delegate` tool only for same-project named agents listed under `delegation.targets`:

```yaml
agents:
  coordinator:
    systemPrompt: Split tasks and combine verified results.
    delegation:
      budget:                 # six-dimensional pool for this parent agent
        tokens: 4000
        toolCalls: 8
        costUsd: 1
        wallTimeMs: 120000
        steps: 12
        descendants: 4
      limits:                 # optional; defaults are 3 / 4 / 32
        maxDepth: 3
        maxActiveChildren: 2
        maxDescendants: 4
      targets:
        researcher:
          preapproved: true # assisted mode only
          budget:
            tokens: 2000
            toolCalls: 4
            costUsd: 0.5
            wallTimeMs: 60000
            steps: 6
            descendants: 0
  researcher:
    systemPrompt: Complete only the delegated research task and return evidence.
```

All six fields are required both for the parent `delegation.budget` pool and for every Target budget. Pools are isolated by parent agent; a Target budget is its fixed default and hard ceiling. A call may provide only a fixed target, task, explicit `fact:` or `artifact:` references, and optional tighter six-dimensional budget, `maxDepth`, or `maxActiveChildren`. It cannot override the agent, provider, model, tools, permissions, paths, network, credentials, or workspace.

The default hierarchy limits are depth 3, four active Child Runs per parent agent, and 32 total descendants; Config and individual calls can only tighten them. An initialization failure proven to occur before the first delegation Fact is persisted releases the reservation. After creation, unused tokens, tool calls, cost, wall time, steps, and descendant capacity are never refunded. If the critical creation-Fact commit result is unknown, CoreMind retains the recorded identity and reservation for orphan audit rather than reusing the DelegationId. The same DelegationId plus the same normalized input returns the original ChildRunId; a different input conflicts without a second execution.

Delegation has a stricter approval matrix than ordinary low-risk tools. `ask` approves every delegation; `assisted` auto-approves only a target explicitly marked `preapproved: true` when the complete request satisfies every hard boundary; `full` may create a compliant Child Run without a prompt. Explicit deny rules, the target allowlist, all six budget dimensions, non-expanding child tools, and path, network, and credential boundaries always win. Approval binds the fixed target, task, references, and effective limits and carries the exact Child Run input fingerprint later recorded as `delegation_recorded.inputFingerprint`, so any change requires a new approval.

Delegation Approval authorizes only creation of that Child Run. The child retains an independent ToolPolicy, and its file, network, and external Effects are separately decided or approved and recorded in the child Run's own audit Facts.

## Permission modes

| Mode | Meaning | Recommended use |
| --- | --- | --- |
| `ask` | Request approval for protected actions | Default for development and unfamiliar projects |
| `assisted` | Auto-approve declared low-risk workspace operations; ask for sensitive actions | Daily development with reviewed tools |
| `full` | Skip prompts only where explicit policy already permits execution | Isolated and deliberately unrestricted environments |

Permission mode does not make unsafe tools safe. Each custom tool must still validate input, limit scope, and report side effects. `full` never disables explicit deny rules, budgets, traces, checkpoints, effect receipts, or resume checks.

## Budgets and loop boundaries

Declare limits for model turns, tool calls, elapsed time, and token or cost budgets where available. A bounded loop must end with a structured reason: success, quality rejection, budget exhaustion, denial, or unrecoverable error.

## Workflow versus explicit Loop

Use `workflow` when the steps and dependencies are known before execution. Use `loop` only when a candidate must pass an independent verifier and bounded repair is allowed. The two fields are mutually exclusive.

```yaml
loop:
  planning:                         # optional
    agent: planner
    input: "Plan: {{prompt}}"
  execute:
    agent: coder
    input: "Execute: {{prompt}}"
  verify:
    agent: reviewer
    input: "Verify: {{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair:
    agent: coder
    input: "Repair {{candidate.text}} using {{verification.text}}"
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair                 # repair, pause, or fail
  onExhausted: fail                # pause or fail
```

Available values include `{{prompt}}`, `{{plan.text}}`, `{{candidate.text}}`, `{{verification.text}}`, `{{iteration}}`, and `{{repairs}}`. A failed verification cannot report success. Iteration, repair, repeated-action, budget, and timeout limits produce explicit pause or failure results.

Every stable Loop state persists a versioned snapshot. `coremind run coremind.yaml --resume <runId>` resumes a paused or interrupted run at that boundary. Tool effects also receive `started`, `committed`, or `unknown` receipts: committed effects do not replay automatically, while unknown effects require human reconciliation.

See the [verified repair golden example](../../../examples/golden/verified-repair-loop/README.en.md) for injected failure, pause-resume, and exhaustion.

## Tools

Enable the smallest set needed by the task. Give each tool a clear schema and description. Separate read-only tools from tools that write files, execute commands, contact external services, or affect other people.

Custom script tools require a structured effect declaration:

```yaml
tools:
  - id: read
  - path: ./src/export-report.mjs
    name: export_report
    effect:
      operations: [write]
      reversible: true
      pathFields: [output.path]
```

Allowed operations are `read`, `write`, `process`, `network`, and `external`. Use `reversible: true` only when the framework can restore every side effect. Missing declarations fail validation; nested path and URL arguments are checked recursively before execution. Custom tools cannot reuse built-in names such as `read`, `write`, or `bash`. On Windows, host-shell execution opens only with full mode, `workspaceOnly: false`, and `network: allow`; every other combination fails closed. Git Bash provides interpreter compatibility rather than isolation.

## Local observation and Telemetry egress

Local observation is always enabled and needs no configuration. The following block controls only the optional process-external Telemetry Projection; omitting it is equivalent to `DISABLED`.

```yaml
telemetry:
  mode: DISABLED              # DISABLED / FEEDBACK_ONLY / FULL
  # endpoint: https://otel.example/v1/traces
  contentLevel: metrics_only  # metrics_only / content
  allowedFields: []
```

- `DISABLED` does not construct an Exporter or read egress credentials. Environment variables and installed monitoring packages never enable it implicitly.
- `FEEDBACK_ONLY` requires the Runtime to persist a scope-fingerprinted feedback consent at critical durability before sending the bounded Fact prefix it covers.
- `FULL` projects only allowed fields after the persisted configuration takes effect. The default `metrics_only` excludes prompts, responses, tool arguments/results, commands, file bodies, full paths, and credentials.
- `content` also requires an independent content consent bound to the same `runId`, target origin, field scope, retention purpose, and revocation method. YAML `content` or `allowedFields` values are not authorization by themselves.
- Local status exposes only the endpoint origin, never query parameters, user information, or credentials. `handed_off` means passed to the Exporter, not stored by the receiver.

CoreMind provides an injectable Exporter seam and offline fault tests. It does not bundle an OTel adapter and does not authorize a live OTLP endpoint, credentials, or network testing. Enabled modes require an `endpoint`; without an Adapter, the run result remains unchanged while the local delivery projection reports `exporter_unavailable`. A trusted Adapter must enforce the exact origin, DNS resolution, redirect/proxy denial, and strict TLS within a bounded timeout before returning resolved addresses and a policy receipt to Core. Core validates only the receipt shape and fingerprint; it cannot prove that network policy was actually enforced. `createTelemetryEgressAuthorization` is a receipt constructor, not DNS/TLS certification.

Telemetry configuration can change when resuming without changing run identity. Runtime first persists a new `telemetry_configuration` Fact at critical durability, and `FULL` projects only Facts at or after its activation sequence instead of backfilling earlier history.

## Quality gates

Quality checks should be observable and repeatable. Examples include schema validation, required citations, test execution, maximum unresolved issues, or a business-specific score threshold. A gate failure must not be rewritten as success.

## Validate changes

```bash
coremind check coremind.yaml
coremind run coremind.yaml --prompt "configuration acceptance"
```

Commit configuration changes together with the tests or examples that demonstrate the intended behavior.
