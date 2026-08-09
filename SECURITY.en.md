# CoreMind Security Policy

Security issues must be handled privately. This page describes responsible reporting and the explicit boundaries of the current prerelease candidate.

[简体中文](SECURITY.md)

## Supported versions

| Version | Security updates |
| --- | --- |
| Latest prerelease line | Supported according to severity and reproducibility |
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
- Secrets belong in environment variables, never configuration, source, logs, traces, screenshots, or fixtures.
- Before persistence or observer delivery, trace events recursively redact secret, token, password, authorization, cookie, private-key, and credential fields. Sensitive URL credentials/query values and command values are also replaced; normal test commands remain reviewable, while body-like content is represented only by a length marker.
- Telemetry is off by default. Explicit approval is required before sending business data to an external model or tool.
- Checkpoint restore compares the post-tool file fingerprint and refuses to overwrite a later user or concurrent edit. Run state and Loop snapshots resume only at validated stable boundaries with matching configuration and input.
- Tool calls record `started`, `committed`, or `unknown` effect receipts. Resume does not replay committed effects automatically, while started or unknown effects require human reconciliation. This is not a universal exactly-once guarantee; email, payment, database writes, and other external effects still need business idempotency, receipts, or compensation.
- The internal state machine controls transitions only. CoreMind configuration fingerprints, permissions, budgets, traces, terminal semantics, and resume validation remain authoritative. Corrupt, unknown-version, or mismatched snapshots are rejected.

Redaction is not data isolation. Sessions, checkpoints, quality override logs, and non-secret trace fields may still contain business context. Protect local state with operating-system access controls and an appropriate retention policy. Before production use, add infrastructure isolation, threat modeling, live-provider retesting, and business evaluations.
