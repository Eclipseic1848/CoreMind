# CoreMind Changelog

This file records user-facing changes. Versions follow Semantic Versioning; beta releases may include explicitly documented interface changes.

[简体中文](CHANGELOG.md)

## 0.2.0-beta.2 — 2026-08-08

### Fixed

- Full-screen TUI now recognizes `/abort` during generation instead of silently ignoring it while busy.
- A run where every tool request is denied and no tool succeeds now returns `paused` instead of incorrectly reporting success.
- `run` and `chat` now fail clearly with guidance when `--session` is used without `session.enabled: true`.

## 0.2.0-beta.1 — 2026-08-08

### Added

- Config v2 and Protocol v1 with aligned TypeScript and Python runtime semantics.
- A bounded execution loop with budgets, permissions, traces, run state, checkpoints, recovery, and quality gates.
- CLI/TUI commands for project creation, execution, chat, checks, evaluation, diagnostics, and templates.
- Sixteen capability modules and four golden examples with bilingual learning and operating material.
- A bilingual documentation site, community governance, issue/PR templates, and npm/PyPI preflight checks.
- Thirty-eight configurable provider entries and an evidence-based certification matrix; Alibaba Cloud Model Studio `qwen-plus` passed all five live checks.
- OS-level Linux shell isolation with networking denied, workspace-only writes, and fail-closed behavior.

### Security and compatibility

- Production dependencies have zero known audit findings.
- Known documentation dev-server risks are isolated by removing server commands, allowing static builds only, and enforcing an expiring risk policy.
- Phase one does not provide Linux-equivalent shell isolation on Windows; macOS is not yet officially supported.

### Upgrade notes

This is a beta upgrade from `0.1.0-alpha.2` to the new public contracts. Regenerate project configuration and run `coremind check`; do not assume Alpha configuration, result fields, or recovery state can be reused unchanged.
