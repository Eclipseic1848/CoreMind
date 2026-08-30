# Changelog

## 0.7.0 - 2026-08-29

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.2 - 2026-08-26

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.1 - 2026-08-21

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0 - 2026-08-13

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0-rc.2 - 2026-08-12

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2 - 2026-08-11

- Added TUI Artifact and context commands plus recovery, compaction, cache, and evaluation status.
- Added the shared pure-JSON `RunSnapshot` to the final CLI JSONL result.

## 0.2.0-rc.1 - 2026-08-09

- Added stable terminal exit codes and a final JSONL `run_result` event with stderr-only diagnostics.
- Made `--print` and `--json-events` mutually exclusive to keep machine output deterministic.
- TUI now displays failed terminal reasons and structured approval details without hiding critical targets behind long content.
- TUI, readline, and JSONL now expose the same explicit Loop state order, and `run --resume` continues safe paused runs without replaying committed effects.
- `doctor <config-file>` now validates the configured `provider.apiKeyEnv` (including the Alibaba default) rather than reporting unrelated fixed-list keys as missing.

## 0.2.0-beta.2 - 2026-08-08

- Fixed busy-state `/abort` handling and explicit validation for `--session` when persistence is disabled.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for CLI and TUI.
