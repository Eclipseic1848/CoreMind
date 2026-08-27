# CoreMind Public Roadmap

CoreMind helps newcomers and application engineers build reliable business agents through configuration, one standard runtime, a bounded harness and loop, quality gates, and task-oriented learning materials.

This public roadmap describes product boundaries and intended directions. It deliberately excludes internal schedules, acceptance records, and maintainer working notes. Priorities may change as real users and community contributors provide feedback.

## Current stable release: `0.3.1` (published)

`0.2.0-rc.1` remains the immutable reference baseline. GitHub Releases, npm, and PyPI determine the latest installable version in each channel. The current `0.3.1` stable release retains `0.3.0` and adds these stability capabilities:

- Three use paths: CLI/TUI, TypeScript and Python SDKs, and full source.
- Single-agent and multi-agent execution, workflows, and budget-bounded loops.
- Config v2, 40 configurable model providers, and custom compatible endpoints.
- `ask`, `assisted`, and `full` permission modes with path policy, approvals, audit, checkpoints, diffs, and recovery.
- Explicit outcomes, budgets, traces, sessions, context protection, tests, evaluations, and release gates.
- Eight project templates, five offline golden examples, two real-defect coding-agent repositories, and 21 capability modules.
- Tests, SOPs, a Skill, bilingual guides, and examples for every capability module.
- Acceptance workflows that combine Windows/Linux automation with real pseudoterminal checks on both platforms, plus synchronized GitHub, npm, PyPI, and bilingual documentation releases.
- Explicit correlation across the Session, Run, and Workspace fact domains; typed identity; I-1 through I-12 invariant checks; input receipts; request rebuilding; and cancellation convergence.

`0.3.1` is publicly released. All eight npm packages, the PyPI wheel, standalone source package, provenance, and bilingual documentation site were published from one commit. The seven-check live-provider revalidation, both-platform automated gates, exact-main identity, P01-P20, real pseudoterminals, and Release Readiness are complete.

It includes the public `loop` configuration, verify-repair states, stable snapshots, pause-resume, effect receipts, bounded retries, a fifth verified-repair golden example, plus the controlled process, read-only Git, bounded unified diff, seven grader types, and TypeScript/Python real-defect evaluations required by coding agents. Every candidate must complete the automated quality gates, both-platform P01-P20, a current live-provider recheck, and the final documentation audit on the same commit before synchronized publication.

## `0.3.2`: merged candidate (unpublished)

The `0.3.2` candidate is merged into `main` and collects the completed `0.3.x-B/C` source work: unified Tool Capability and lifecycle handling, tiered durability and Workspace leasing, Context lifecycle, ReplayKit, always-visible local Observability, and explicit default-off Telemetry egress boundaries. Custom Qwen-compatible endpoints add `thinkingFormat: qwen`, allowing an Agent's `thinkingLevel: off` to send `enable_thinking: false` through a controlled contract while arbitrary request fields remain rejected.

This candidate has completed its current Node 22 both-platform CI, seven-check live Provider certification, and RC acceptance, but it has no tag, registry artifact, GitHub Release, or post-release documentation synchronization. `0.3.1` therefore remains the only public stable release. Protocol v2, AgentDriver, and ExecutionEnvironment changes merged later belong to unreleased `0.4.x` source and do not expand the `0.3.2` candidate scope retroactively.

## `0.3.x`: stabilization hardening (in progress)

The `0.3.x` line hardens runtime semantics in three approved batches (A → B → C) through compatibility-first evolution. It does not create a second Runtime or pull Web, Jobs, or subagents forward. Config v2, Protocol v1, the three permission modes, and existing successful paths remain compatible; new fail-closed states that prevent silent loss, duplicate effects, or privilege expansion must be explicit, migratable, reversible, and maintainer-confirmed:

- **0.3.x-A: facts, identity, and cancellation convergence** — a single source of truth with derived projections (three fact domains: Session / Run / Workspace), typed identity and correlation invariants, and cancellation convergence with input receipts. The design and implementation issues [#35–#42](https://github.com/Eclipseic1848/CoreMind/issues/35) are complete and publicly released in `0.3.1`.
- **0.3.x-B: tools and recovery** — one resolved Tool Capability, an explicit stage graph with monotonic security, tiered Durability Barriers, a single-writer Workspace lease, persistence failure contracts, and orthogonal error results. The source work is complete and included in the merged `0.3.2` candidate; Windows isolation experiments remain separately authorized spikes.
- **0.3.x-C: evidence system** — event replay and real-entry testing, a cross-model long-horizon Context lifecycle, per-file quality gates for critical modules, provider certification hardening, and an observability baseline that is locally visible with explicit egress. Source, both-platform CI, live Provider, and RC evidence gates are complete in the merged `0.3.2` candidate; tag, registries, and Release remain undone.

Version numbers and dates are not promised; each batch proceeds only after its acceptance gates pass and the maintainer confirms. A provider that has not passed live verification remains configurable but is not marked as officially certified.

## Long-term roadmap: 0.4 through 1.0

After the `0.3.x` hardening line, work proceeds in the following directions (scope and acceptance are confirmed by the maintainer before each phase starts):

- **0.4.x**: Protocol v2 with RunHandle, resumable events, durable control receipts, AgentDriver, and ExecutionEnvironment seams is merged as source on `main`, while a v1 migration entry remains throughout `0.4.x`. Merged source is not a published `0.4.0`; a version candidate and release gates remain required.
- **0.5.x–0.6.x**: the Web development environment — run and control surface first, then online editing, testing, and evaluation; always reusing the same Protocol and Runtime.
- **0.7.x**: Goals, Jobs, and subagents — an unpublished Child Run source candidate now has independent facts, actual-Runtime authority checks, parent budget reservation, parent-child cancellation, orphan audit, workspace lease projection, an explicit tree, and local cross-process crash and single-Writer acceptance. Goals, Jobs, durable detach, real product acceptance, and release gates remain incomplete.
- **0.8.x**: MCP/LSP adapters, controlled third-party plugins, remote execution environments, and the platform ecosystem.
- **0.9.x–1.0.0**: feature freeze, compatibility and security closure, and a stable contract after a formal release candidate.

## `0.3.0`: phase-two kernel and engineering loop

Phase two advances through `alpha → beta → rc` and strengthens the framework kernel without changing CoreMind's three use paths:

- Align critical dependency versions and isolate low-level implementations behind private adapters.
- Establish durable harness operations that can abort, pause, resume, and recover without duplicating committed effects.
- Improve context selection, compaction evidence, long-output artifacts, and observable metrics.
- Build a first-party Coding/Engineering Kernel for repository understanding, minimal edits, diffs, verification, repair, and regression.
- Keep outcomes, events, approvals, and recovery consistent across TUI, headless CLI, TypeScript SDK, and Python SDK.
- Ship tests, SOP, Skill, bilingual guides, examples, migration, and rollback guidance with every batch.

`0.3.0-rc.2` completed Batches 0 through 6: critical dependencies use one exact family behind private adapters; runs have a durable operation envelope, atomic RunState, Session backend conformance, backed-up migration, and non-replay boundaries for uncertain effects; long tasks add stable context prefixes, deterministic compaction evidence, truthful cache metrics, and controlled workspace artifacts; coding is a first-party Engineering Kernel inside the Runtime; and the extension surface is limited to four controlled lifecycle events with traceable experiments, a seven-check provider contract, TUI evidence views, and one shared `RunSnapshot` across all entry points. The `0.3.0` stable release adds no product behavior and only synchronizes stable versions and release materials. The current evidence ledger, Releases, and registries remain authoritative for candidate provider status, public availability, and final assets.

Phase two starts from an immutable `0.2.0-rc.1` reference baseline that freezes public types, Config/Protocol schemas, the critical dependency combination, P01-P20, both-platform behavior, same-task coding-evaluation conditions, and quality floors. Coverage may improve but may not regress. Every intentional contract change must explain migration and rollback; gates are never lowered merely to pass.

## Phase three: Web development environment

Phase three is planned to add a complete browser-based development experience:

- Visual configuration of agents, tools, and workflows.
- Online code editing and project file management.
- Trace debugging, testing, and evaluation panels.
- Permission approval, run-state, and result inspection.
- Release and deployment guidance.

The Web environment will reuse CoreMind Protocol and the existing runtime instead of introducing another execution engine.

## Later platform and ecosystem work

- Formal macOS support.
- More community templates, Skills, business modules, and golden examples.
- Live certification for additional model providers.
- Continued improvements to contributor development, testing, review, and release workflows.

Every new capability must continue to ship with implementation, tests, SOP, Skill, bilingual guidance, and examples.

## Explicit boundaries

CoreMind does not decide business goals, data fields, approval ownership, or agent architecture for users, and it does not promise to implement every business application automatically. There is currently no plan for an official hosted API, multi-tenant SaaS, official Docker image, or separate pure-Python runtime.

Users own business direction and final acceptance. CoreMind owns engineering mechanisms, safety boundaries, quality evidence, and development guidance.

## Participate in the roadmap

Use [GitHub Issues](https://github.com/Eclipseic1848/CoreMind/issues) for adoption feedback, defects, and capability proposals. Before contributing code, read the [contribution guide](../CONTRIBUTING.en.md) and [security policy](../SECURITY.en.md).
