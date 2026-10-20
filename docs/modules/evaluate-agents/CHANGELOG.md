# Changelog

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## Unreleased

- 修复 Diff grader 在 `preserveExisting: false` 时的差异判定：只关闭既有脏内容保护，路径与文件数约束继续按基线和终态的状态或内容差异执行；状态和内容均未变化的既有脏文件不计，原 untracked 文件删除计入变化，默认 `true` 保护不变（#328）。
- Fix Diff grader change detection with `preserveExisting: false`: only pre-existing dirty-content protection is disabled; path and file-count constraints still use baseline-to-final status or content differences. Dirty files with unchanged status and content do not count, deleting a previously untracked file does, and default `true` protection remains unchanged (#328).
- Added artifact-verified paired evaluation with isolated cells, complete failure accounting, and separate startup, stream, cancellation, and size measurements.
- Documented immutable inputs, unavailable metrics, local fixture limits, and reproducible raw reports without automatic review approval.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.7.0 - 2026-08-29

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the stable release.

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

## 0.3.0-beta.2 - 2026-08-11

- Added deterministic experiment definitions, weighted arm selection, environment capture, complete run traces, and grader evidence.
- Documented fair-comparison, input-fingerprint, privacy, and gate-freezing requirements.

## 0.2.0-rc.1 - 2026-08-09

- Added schemaVersion 2 with outcome, trajectory, command, file, diff, state, and response graders.
- Added dirty-worktree preservation, bounded command/file/diff evaluation, property tests, and real TypeScript/Python defect repositories.
- Separated expected tool failures and non-reversible-effect warnings from security findings.
- Declared the Runtime project's 15-second test Harness limit locally so process-backed grader tests do not inherit Vitest's five-second default under load.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Testing, Evaluation, and Quality Gates.
