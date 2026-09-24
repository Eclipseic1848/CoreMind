# CoreMind Security Policy

Security issues must be handled privately. This page describes responsible reporting and the explicit boundaries of the current stable release and development source.

[简体中文](SECURITY.md)

## Supported versions

| Version | Security updates |
| --- | --- |
| Latest stable `0.8.x` | Supported according to severity and reproducibility |
| `0.3.1` | Critical security issues only; upgrade to the latest stable release |
| Older alpha, beta, or RC versions | Not guaranteed; upgrade and retest first |
| Unreleased branches or personal forks | Outside project support |

## Report privately

Use **Report a vulnerability** on the repository Security page when available. Do not disclose exploit details in a public issue, discussion, pull request, or chat. Include the affected version, platform, prerequisites, minimal reproduction, impact, and disclosure status. Remove credentials and sensitive data.

If no private entry point is available, open a public issue without technical details and ask maintainers for a private contact channel. Response times are targets, not an SLA.

## Security boundaries

- Permission modes control approval behavior; they do not make risky tools inherently safe. Explicit deny rules, workspace restrictions, budgets, traces, checkpoints, effect receipts, and resume checks remain active even in `full`. Start unfamiliar work in `ask` mode.
- On Linux, the built-in shell can run inside OS-level isolation with networking denied and writes restricted to the workspace. Execution fails closed when isolation is unavailable. A critical isolation dependency is still a research preview.
- Phase one has no Linux-equivalent OS shell sandbox on Windows. The host shell opens only when `mode: full`, `workspaceOnly: false`, and `network: allow` are all selected explicitly. Every other combination is denied with guidance to use path-aware file tools or an isolated Linux environment. Discovering Git Bash provides command-interpreter compatibility, not isolation. Explicit deny rules, trace, checkpoints, diffs, audit, and restore remain active even when the shell is open.
- Custom TypeScript, Python, and script tools must declare operations, reversibility, and non-standard target fields. They do not automatically receive OS isolation, and authors still own validation, least privilege, timeouts, idempotency, and side-effect control.
- CoreMind observes actual execution capabilities through ExecutionEnvironment probes; platform names, adapter labels, configuration fields, and historical tests are not substitutes for current-process evidence. Linux negatively probes outside-workspace writes, sensitive environment hiding, network denial, and complete process-tree termination. Missing, overstated, or insufficient evidence fails closed. Windows Trusted Host reports that it is not a sandbox and cannot satisfy isolation or controlled-egress requirements.
- AgentDriver isolates only the model reactive loop. It cannot write authoritative facts, decide recovery, or bypass the single ToolExecutionEngine. Processes, network calls, and temporary resources participate in Quiescent, and failed cancellation cleanup cannot be projected as successful quiescence.
- A Child Run is an independent Run, not an ordinary tool call. Its parent policy binds the actual provider/model, canonical workspace, permissions, tools, environment probe, and finite Runtime budget, and a child can only narrow them. Parent cancellation reaches quiescence only after every child terminates or pauses, critical facts flush, and structured join completes. Uncertain restored ownership enters orphan audit pause and is not restarted automatically. Durable detach is not currently supported.
- In Protocol v2, a `RunHandle` means only that a start request was accepted; it does not prove a Provider call, tool authorization, or success. An `accepted` control receipt is not `applied`, and a Cancel acknowledgment is not Abort, a terminal outcome, or Quiescent. Controls enter a durable ControlInbox before Runtime facts are produced. Disconnect does not cancel by default; reconnect deduplicates by `(runId, sequence, eventId)`, and rebuildable Projection queries cannot become fact or authorization. Protocol v1 remains supported with no approved removal plan.
- Secrets enter through environment references or a `SecretRef` resolver supplied by an embedding host, never plaintext configuration, source, logs, traces, screenshots, or fixtures. The CLI, Python SDK, and standard Worker do not supply a resolver; resolution failure is fail-closed without fallback.
- Sensitive custom Provider Headers require an environment reference or `SecretRef`. Besides Authorization, Proxy-Authorization, X-API-Key, and Cookie, common aliases including `api-key`, `x-auth-token`, `x-access-token`, `x-goog-api-key`, and `x-amz-security-token` also reject plaintext literals.
- Before persistence or observer delivery, trace events recursively redact secret, token, password, authorization, cookie, private-key, and credential fields. Sensitive URL credentials/query values and command values are also replaced; normal test commands remain reviewable. Tool argument bodies retain only length markers; non-sensitive step output remains available for recovery. A step candidate containing a recognizable credential fails with `redaction_failed` before persistence or host verification, preserving the original candidate hash contract. Streaming text buffers incomplete fragments and may wait until the turn ends; an unclosed fragment exceeding 65,536 characters fails closed.
- Local Observability is visible by default, but it only projects canonical facts on the local machine. Enabling a local view is not consent for egress, and a projection cannot be written back as recovery authority.
- Telemetry defaults to `DISABLED`: no exporter is constructed, no egress credential is read, and no network request is sent. `FEEDBACK_ONLY` may send only the bounded fact prefix covered by durable consent; `FULL` may still send only allowlisted fields after its configuration takes effect.
- The default content level is `metrics_only`. Prompts, responses, tool arguments or results, commands, file content, full paths, environment values, and credentials cannot be exported. `content` requires separate explicit consent and cannot be inferred from `FULL` mode.
- Exporter queue, retry, drop, authentication, timeout, or shutdown failures may produce local observations only; they cannot change RunOutcome, fact sequence, RecoveryDecision, or EffectState.
- Checkpoint restore compares the post-tool file fingerprint and refuses to overwrite a later user or concurrent edit. Run state and Loop snapshots resume only at validated stable boundaries with matching configuration and input.
- Artifact import accepts only canonical ordinary files under the allowed temporary root. It rejects symlinks, linked parent directories, canonical-path escape, and file-identity changes before reading; a temporary source is removed only after consumption and a matching identity recheck.
- Tool calls record `started`, `committed`, or `unknown` effect receipts. Resume does not replay committed effects automatically, while started or unknown effects require human reconciliation. This is not a universal exactly-once guarantee; email, payment, database writes, and other external effects still need business idempotency, receipts, or compensation.
- The internal state machine controls transitions only. CoreMind configuration fingerprints, permissions, budgets, traces, terminal semantics, and resume validation remain authoritative. Corrupt, unknown-version, or mismatched snapshots are rejected.

Redaction is not data isolation. Sessions, checkpoints, quality override logs, and non-secret trace fields may still contain business context. Protect local state with operating-system access controls and an appropriate retention policy. Before production use, add infrastructure isolation, threat modeling, live-provider retesting, and business evaluations.

Unpublished source hardening: built-in file approval, checkpoints, and execution share a resolved target and recheck before execution. This is not an OS sandbox and cannot eliminate filesystem races from a malicious host process. Git tools require Git 2.36+, disable fsmonitor and external diff/textconv execution, and restrict default reads to the working directory; repository configuration is not trusted code.

Linux `web-fetch` and `web-search` use an explicitly declared host network environment, still subject to tool authorization and network policy. They do not claim the Shell sandbox's network isolation. A Child Run enabling either tool must satisfy the actual host network environment's complete capability requirements. Cancellation waits for both parent and network activities to settle.
