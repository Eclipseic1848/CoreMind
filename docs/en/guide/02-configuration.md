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

Providers are inherited dynamically from the locked runtime family. `0.2.0-rc.1` contains 37 inherited entries; both `0.3.0-rc.2` and the current `0.3.0` stable release contain 39 inherited entries plus one CoreMind-native entry, for 40 configurable Providers. Use `listInheritedProviders()` to inspect the exact installed catalog. Configurability is not current-version live certification.

Built-in tool IDs are `read`, `ls`, `find`, `grep`, `bash`, `edit`, `write`, `git_status`, `git_diff`, `git_log`, `web-fetch`, and `web-search`. The three Git tools are fixed read-only operations and never commit, switch, clean, or push a repository.

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
Proxy-Authorization, X-API-Key, and Cookie values must use `{ env: "NAME" }` or
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
