# CoreMind Security Policy

Security issues must be handled privately. This page describes responsible reporting and the explicit boundaries of the current Alpha release.

[简体中文](SECURITY.md)

## Supported versions

| Version | Security updates |
| --- | --- |
| Latest Alpha line | Supported according to severity and reproducibility |
| Older Alpha versions | Not guaranteed; upgrade and retest first |
| Unreleased branches or personal forks | Outside project support |

## Report privately

Use **Report a vulnerability** on the repository Security page when available. Do not disclose exploit details in a public issue, discussion, pull request, or chat. Include the affected version, platform, prerequisites, minimal reproduction, impact, and disclosure status. Remove credentials and sensitive data.

If no private entry point is available, open a public issue without technical details and ask maintainers for a private contact channel. Response times are targets, not an SLA.

## Security boundaries

- Permission modes control approval behavior; they do not make risky tools inherently safe. Start unfamiliar work in `ask` mode.
- On Linux, the built-in shell can run inside OS-level isolation with networking denied and writes restricted to the workspace. Execution fails closed when isolation is unavailable. A critical isolation dependency is still a research preview.
- Phase one has no equivalent OS-level shell sandbox on Windows.
- Custom TypeScript and Python tools do not automatically receive OS isolation. Authors own validation, least privilege, timeouts, idempotency, and side-effect control.
- Secrets belong in environment variables, never configuration, source, logs, traces, screenshots, or fixtures.
- Telemetry is off by default. Explicit approval is required before sending business data to an external model or tool.
- Checkpoints cannot automatically reverse email, payment, database writes, or other external side effects. Business tools need receipts, idempotency, or compensation.

Treat sessions, traces, checkpoints, and quality override logs as potentially sensitive. Before production use, add infrastructure isolation, threat modeling, live-provider retesting, business evaluations, and a retention policy appropriate to your risk.
