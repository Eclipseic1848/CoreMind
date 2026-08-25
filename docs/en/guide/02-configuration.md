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

The current source provides an injectable Exporter seam and offline fault tests. It does not bundle an OTel adapter and does not authorize a live OTLP endpoint, credentials, or network testing. Enabled modes require an `endpoint`; without an Adapter, the run result remains unchanged while the local delivery projection reports `exporter_unavailable`. A trusted Adapter must enforce the exact origin, DNS resolution, redirect/proxy denial, and strict TLS within a bounded timeout before returning resolved addresses and a policy receipt to Core. Core validates only the receipt shape and fingerprint; it cannot prove that network policy was actually enforced. `createTelemetryEgressAuthorization` is a receipt constructor, not DNS/TLS certification.

Telemetry configuration can change when resuming without changing run identity. Runtime first persists a new `telemetry_configuration` Fact at critical durability, and `FULL` projects only Facts at or after its activation sequence instead of backfilling earlier history.

## Quality gates

Quality checks should be observable and repeatable. Examples include schema validation, required citations, test execution, maximum unresolved issues, or a business-specific score threshold. A gate failure must not be rewritten as success.

## Validate changes

```bash
coremind check coremind.yaml
coremind run coremind.yaml --prompt "configuration acceptance"
```

Commit configuration changes together with the tests or examples that demonstrate the intended behavior.
