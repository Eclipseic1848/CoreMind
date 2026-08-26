# Runtime Dependency Upgrade Spike Template

> This is an investigation and acceptance checklist. It does not authorize dependency installation, external calls, commits, pull requests, merges, or releases. Copy it before filling it in; do not rewrite placeholder semantics to bypass a gate.

## 1. Identity and scope

- Spike ID: `<id>`
- Owner: `<name>`
- Date: `<YYYY-MM-DD>`
- Reference version: `<package>@<exact version>`
- Candidate version: `<package>@<exact version>`
- Upstream tag/commit: `<full commit SHA>`
- Lockfile hashes before/after: `<SHA-256>` / `<SHA-256>`
- Affected private seams: `<Provider / AgentDriver / Session / Tool / ExecutionEnvironment>`
- Explicit non-goals: `<capabilities not implemented by this spike>`

List the complete critical dependency family with exact versions. Do not record only direct dependencies or version ranges.

| Package | Reference | Candidate | Transitive change | License/NOTICE | Decision |
| --- | --- | --- | --- | --- | --- |
| `<package>` | `<x.y.z>` | `<x.y.z>` | `<summary>` | `<evidence>` | `<pending>` |

## 2. Change and risk hypotheses

- Upstream protocol/event/message changes: `<facts and links>`
- Tool-call and concurrency changes: `<facts and links>`
- Abort/timeout/late-result changes: `<facts and links>`
- Session format and recovery changes: `<facts and links>`
- Usage, cost, and error-classification changes: `<facts and links>`
- Platform, sandbox, and process-tree changes: `<facts and links>`
- Supply-chain, maintenance, and vulnerability status: `<facts and links>`
- CoreMind invariants at risk: `<list>`

Record upstream claims separately from candidate probe results. Mark every unprobed capability as not sufficiently verified.

## 3. Red tests and minimal adapter plan

Write failing contracts before changing private adapters.

| Contract | Reference red | Candidate green | Evidence path |
| --- | --- | --- | --- |
| Provider stream/final message | `<result>` | `<result>` | `<log/test>` |
| Tool batch/order/concurrency | `<result>` | `<result>` | `<log/test>` |
| Abort/late result/Quiescent | `<result>` | `<result>` | `<log/test>` |
| Session roundtrip/legacy fixture | `<result>` | `<result>` | `<log/test>` |
| AgentDriver observation | `<result>` | `<result>` | `<log/test>` |
| ExecutionEnvironment probe | `<result>` | `<result>` | `<log/test>` |

- Files allowed to change: `<adapters and contract tests>`
- Public contracts that must not change: `<Config / Protocol / SDK / Fact / Outcome / Recovery>`

## 4. Protocol and recovery compatibility

- Protocol v1 fixture: `<pass/fail/not applicable + evidence>`
- Protocol v2 schema/fingerprint: `<pass/fail/not applicable + evidence>`
- Same Facts produce the same RunSnapshot: `<evidence>`
- Same Facts produce the same RecoveryDecision: `<evidence>`
- Read compatibility for legacy Session/RunState: `<evidence>`
- Public declaration private-type scan: `<evidence>`
- No second Runtime or entry-specific bypass: `<review conclusion>`

## 5. Four-entry and dual-platform matrix

Every cell must include the actual command, exit code, run identity, and log hash. A planned run is not a pass.

| Platform | CLI | TUI | TypeScript | Python Worker |
| --- | --- | --- | --- | --- |
| Windows | `<evidence>` | `<evidence>` | `<evidence>` | `<evidence>` |
| Linux | `<evidence>` | `<evidence>` | `<evidence>` | `<evidence>` |

Additional contracts:

- Process-tree kill/timeout: `<Windows evidence>` / `<Linux evidence>`
- Sandbox/egress/credential negative probes: `<evidence>`
- PTY, if claimed: `<evidence; otherwise explicitly unsupported>`
- Cancel to Quiescent and Worker exit: `<evidence>`

## 6. Provider and external boundaries

- Offline faux/replay: `<evidence>`
- Real Provider certification: `<not authorized / authorized scope / evidence>`
- Exact outbound scope: `<provider, endpoint, model, message/tool-schema fields>`
- Credential source and lifetime: `<process memory only; never persisted>`
- Cost ceiling: `<amount/request count>`

Offline tests, CI, PR readiness, or checksums do not replace real Provider certification. Certification does not authorize release.

## 7. Performance and supply chain

- One installed dependency family: `<evidence>`
- Clean install/build/tarball: `<evidence>`
- Package-size change: `<before/after/threshold>`
- Provider first-token, tool-start, and run-completion baselines: `<before/after/conclusion>`
- License, NOTICE, signature, and provenance: `<evidence>`
- Security audit: `<evidence and disposition>`

## 8. Rollback rehearsal

- Rollback point: `<branch/SHA/lockfile hash>`
- Whole dependency family to restore: `<list>`
- Non-destructive rollback command: `<command>`
- Post-rollback build/test/four-entry evidence: `<path>`
- Whether the prior version reads candidate data: `<conclusion>`
- Irreversible external effects: `<none / details and manual handling>`

Never mix old and new critical dependencies, and never rewrite historical Session/RunState data to simulate rollback.

## 9. Conclusion and independent authorization gates

- Spike decision: `<Go / No-Go / more evidence required>`
- Unresolved risks: `<list>`
- Recommended exact version: `<version or no upgrade>`
- Implementation authorization: `<not requested / granted>`
- Git/PR authorization: `<not requested / granted>`
- Real Provider authorization: `<not requested / granted>`
- Release-candidate authorization: `<not requested / granted>`
- Merge/tag/publish authorization: `<not requested / granted>`

These gates are independent. Do not infer later authority from “continue,” design approval, or a passing check.
