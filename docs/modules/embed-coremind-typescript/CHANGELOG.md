# Changelog

## 0.3.0-rc.1 - 2026-08-11

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2 - 2026-08-11

- Exported the common `RunSnapshot`, lifecycle-extension, and lightweight-experiment contracts from the single SDK facade.
- Added pure-JSON snapshot guidance for cross-process and cross-language consumers.

## 0.2.0-rc.1 - 2026-08-09

- Runtime and ChatSession now expose every normal terminal state through RunResult instead of mixing returns and exceptions.
- TypeScript custom tools now require structured effect declarations.
- Exported public Loop configuration and phase types, with state-order, pause-resume, and effect-receipt parity across all entry paths.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for TypeScript SDK.
