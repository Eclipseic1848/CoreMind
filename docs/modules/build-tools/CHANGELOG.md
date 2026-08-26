# Changelog

## 0.3.2 - 2026-08-26

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.1 - 2026-08-21

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0 - 2026-08-13

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.2 - 2026-08-12

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.2.0-rc.1 - 2026-08-09

- Added a bounded `ProcessRunner`, read-only `GitAdapter`, and bounded unified diff helpers.
- Added Windows shell selection and fail-closed permission combinations without weakening Linux isolation.
- Added timeout, cancellation, output, environment, path, link, and complexity tests.
- Made caller-supplied host-shell environments authoritative and added deterministic Git Bash, PowerShell fallback, minimal-environment, and execution-context isolation coverage.
- Kept the repository test harness's outer timeout above the tool's own bounded timeout so loaded runners can report the real process outcome instead of a test-harness timeout.

### Earlier candidate work

- Added mandatory structured effect declarations for script, TypeScript, and Python tools, including optional dotted path and URL field selectors.
- Added fail-closed handling for undeclared effects under workspace or network restrictions.
- Rejected custom tools that reuse reserved built-in names.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Tools and Business Capabilities.
