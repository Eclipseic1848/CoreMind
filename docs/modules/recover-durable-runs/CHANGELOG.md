# Changelog

## 0.7.1 - 2026-09-03

- Appended ordinary FileRunStore Facts incrementally and recovered Protocol v2 duplicate/conflict decisions from durable Facts after terminal-state memory reclamation.

## 0.7.0 - 2026-08-29

- Recorded denied effects as not started, rejected semantic or out-of-order state corruption, and aligned resumable snapshots with the actual recovery preflight.

## 0.3.2 - 2026-08-26

- Recorded denied effects as not started, rejected semantic or out-of-order state corruption, and aligned resumable snapshots with the actual recovery preflight.

## 0.3.1 - 2026-08-21

- Added the internal I-1 through I-12 correlation invariant checker with `off`, `eval`, and `gate` modes.
- Added tracked current and legacy fixtures, including the 0.3.0-to-0.3.1 Resume compatibility boundary.
- Synchronized the bilingual README, guide, SOP, Skill, example, and module manifest.

## 0.3.0 - 2026-08-13

- Recorded denied effects as not started, rejected semantic or out-of-order state corruption, and aligned resumable snapshots with the actual recovery preflight.

## 0.3.0-rc.2 - 2026-08-12

- Recorded denied effects as not started, rejected semantic or out-of-order state corruption, and aligned resumable snapshots with the actual recovery preflight.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2 - 2026-08-11

- Added the shared `RunResult.snapshot` recovery contract across CLI, Worker, TypeScript, and Python entry points.
- Added snapshot schema validation, parity checks, and explicit rejection of inconsistent terminal data.
- Updated the bilingual README, guide, SOP, Skill, example, and module manifest.

## 0.3.0-alpha.2 - 2026-08-10

- Added a durable operation lifecycle and recovery validation.
- Added atomic RunState publication, writer conflict handling, bounded torn-tail repair, and fault-injection tests.
- Added Memory/JSONL Session conformance and backed-up, idempotent legacy migration.
- Correlated tool calls, effect receipts, checkpoints, operation snapshots, and terminal records.
- Added bilingual README, guide, SOP, Skill, example, and module manifest.
