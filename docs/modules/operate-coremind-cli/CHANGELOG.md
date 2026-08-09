# Changelog

## Unreleased

- Added stable terminal exit codes and a final JSONL `run_result` event with stderr-only diagnostics.
- Made `--print` and `--json-events` mutually exclusive to keep machine output deterministic.
- TUI now displays failed terminal reasons and structured approval details without hiding critical targets behind long content.
- TUI, readline, and JSONL now expose the same explicit Loop state order, and `run --resume` continues safe paused runs without replaying committed effects.

## 0.2.0-beta.2 - 2026-08-08

- Fixed busy-state `/abort` handling and explicit validation for `--session` when persistence is disabled.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for CLI and TUI.
