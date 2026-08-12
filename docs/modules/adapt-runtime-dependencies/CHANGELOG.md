# Changelog

## 0.3.0-rc.2 - 2026-08-12

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-alpha.1

- Aligned the critical runtime, model, and coding-tool dependencies to one exact version family.
- Removed cross-version tool bridges and added a CoreMind-owned compatibility report.
- Adapted Session persistence to the versioned repository interface while preserving CoreMind roundtrip and compaction behavior.
- Preserved the stable `session.dir/<id>.jsonl` public path and explicit corrupt-file failure semantics.
- Added lockstep, dependency-report, Provider, usage, error, timeout, tool, and Session gates.
