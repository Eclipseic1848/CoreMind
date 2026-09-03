# CoreMind Security Policy

Security issues must be handled privately. This page describes responsible reporting and the explicit boundaries of the current stable release and development source.

[简体中文](SECURITY.md)

## Supported versions

| Version | Security updates |
| --- | --- |
| Tagged `v0.7.0` candidate | Handled before publication according to severity and reproducibility |
| Current public stable `0.3.1` | Supported according to severity and reproducibility |
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
- In Protocol v2, a `RunHandle` means only that a start request was accepted; it does not prove a Provider call, tool authorization, or success. An `accepted` control receipt is not `applied`, and a Cancel acknowledgment is not Abort, a terminal outcome, or Quiescent. Controls enter a durable ControlInbox before Runtime facts are produced. Disconnect does not cancel by default; reconnect deduplicates by `(runId, sequence, eventId)`, and rebuildable Projection queries cannot become fact or authorization. The v1 migration entry remains throughout `0.4.x`.
- Secrets belong in environment variables, never configuration, source, logs, traces, screenshots, or fixtures.
- Before persistence or observer delivery, trace events recursively redact secret, token, password, authorization, cookie, private-key, and credential fields. Sensitive URL credentials/query values and command values are also replaced; normal test commands remain reviewable, while body-like content is represented only by a length marker.
- Local Observability is visible by default, but it only projects canonical facts on the local machine. Enabling a local view is not consent for egress, and a projection cannot be written back as recovery authority.
- Telemetry defaults to `DISABLED`: no exporter is constructed, no egress credential is read, and no network request is sent. `FEEDBACK_ONLY` may send only the bounded fact prefix covered by durable consent; `FULL` may still send only allowlisted fields after its configuration takes effect.
- The default content level is `metrics_only`. Prompts, responses, tool arguments or results, commands, file content, full paths, environment values, and credentials cannot be exported. `content` requires separate explicit consent and cannot be inferred from `FULL` mode.
- Exporter queue, retry, drop, authentication, timeout, or shutdown failures may produce local observations only; they cannot change RunOutcome, fact sequence, RecoveryDecision, or EffectState.
- Checkpoint restore compares the post-tool file fingerprint and refuses to overwrite a later user or concurrent edit. Run state and Loop snapshots resume only at validated stable boundaries with matching configuration and input.
- Tool calls record `started`, `committed`, or `unknown` effect receipts. Resume does not replay committed effects automatically, while started or unknown effects require human reconciliation. This is not a universal exactly-once guarantee; email, payment, database writes, and other external effects still need business idempotency, receipts, or compensation.
- The internal state machine controls transitions only. CoreMind configuration fingerprints, permissions, budgets, traces, terminal semantics, and resume validation remain authoritative. Corrupt, unknown-version, or mismatched snapshots are rejected.

Redaction is not data isolation. Sessions, checkpoints, quality override logs, and non-secret trace fields may still contain business context. Protect local state with operating-system access controls and an appropriate retention policy. Before production use, add infrastructure isolation, threat modeling, live-provider retesting, and business evaluations.
