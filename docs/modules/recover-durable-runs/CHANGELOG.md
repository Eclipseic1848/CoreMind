# Changelog

## Unreleased — 1.4.0 development

- Added keyed runCalls/executeTool, durable call queries, ordered replay checks and original-Run reconciliation. Shared budgets, ChildRun limits and unknown-effect gates remain enforced. Added crash-window and projection-fault checks, bilingual docs, offline example and ADR 0028. Release still requires original CI/security and merge acceptance. ([#365](https://github.com/Eclipseic1848/CoreMind/issues/365))

- Added durable sleepUntil/nextWake/wake with deadline checks, sleep-bound idempotency, cancellation and cold-process recovery. Waiting preserves all execution timeouts. Added host alarm example, bilingual guidance, compatibility notes and ADR 0027; original CI and merge qualification remain required. ([#364](https://github.com/Eclipseic1848/CoreMind/issues/364))

- Added public TypeScript TaskSession phase execution and explicit migration over TaskCommit, preserving existing Run governance and failing closed on unresolved Run windows. Added process recovery, migration, concurrency, cancellation and local HTTP governance checks, ADR 0026, bilingual task guides and an offline example. ([#363](https://github.com/Eclipseic1848/CoreMind/issues/363))

- Added the opt-in internal TaskCommit authority for atomic task checkpoint, typed document and text-entry publication, with revision conflicts, content-bound idempotency and process-crash recovery.
- Preserved legacy Session/Run/Workspace data and Run tail repair; task journals fail closed on truncation. Added task paths to standard Runtime write protection.
- Added real child-process exit/ownership regressions, a model-free runnable example, ADR 0025 and bilingual operational guidance. This is storage infrastructure, not public task execution or release qualification. ([#362](https://github.com/Eclipseic1848/CoreMind/issues/362))

## 1.3.0 - 2026-10-20

- Synchronized module contracts and version metadata for the 1.3.0 release line; publication requires qualification for the final commit and exact artifacts.

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Removed redundant temporary-lock synchronization while preserving complete atomic owners and critical Fact durability at the process-crash boundary.
- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

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
