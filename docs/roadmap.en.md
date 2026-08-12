# CoreMind Public Roadmap

CoreMind helps newcomers and application engineers build reliable business agents through configuration, one standard runtime, a bounded harness and loop, quality gates, and task-oriented learning materials.

This public roadmap describes product boundaries and intended directions. It deliberately excludes internal schedules, acceptance records, and maintainer working notes. Priorities may change as real users and community contributors provide feedback.

## Current public prerelease: `0.2.0-rc.1`

The current public version includes:

- Three use paths: CLI/TUI, TypeScript and Python SDKs, and full source.
- Single-agent and multi-agent execution, workflows, and budget-bounded loops.
- Config v2, 40 configurable model providers, and custom compatible endpoints.
- `ask`, `assisted`, and `full` permission modes with path policy, approvals, audit, checkpoints, diffs, and recovery.
- Explicit outcomes, budgets, traces, sessions, context protection, tests, evaluations, and release gates.
- Eight project templates, five offline golden examples, two real-defect coding-agent repositories, and 21 capability modules.
- Tests, SOPs, a Skill, bilingual guides, and examples for every capability module.
- Acceptance workflows that combine Windows/Linux automation with real TTY checks on both platforms, plus synchronized GitHub, npm, PyPI, and bilingual documentation releases.

The current version is a prerelease. You are welcome to evaluate it in development and test environments and help improve it through community feedback.

It includes the public `loop` configuration, verify-repair states, stable snapshots, pause-resume, effect receipts, bounded retries, a fifth verified-repair golden example, plus the controlled process, read-only Git, bounded unified diff, seven grader types, and TypeScript/Python real-defect evaluations required by coding agents. Every candidate must complete the automated quality gates, both-platform P01-P20, a current live-provider recheck, and the final documentation audit on the same commit before synchronized publication.

## `0.2.x`: phase-one stabilization

The stabilization line focuses on reliability and usability of the delivered scope:

- Continue improving the Windows and Linux TUI experience and terminal compatibility.
- Fix installation, configuration, diagnostics, and interaction issues found during initial community use.
- Expand provider certification backed by real invocation evidence.
- Continue cross-language checks for CLI, TypeScript SDK, and Python SDK outcomes and events.
- Include the completed bounded-Loop and coding-agent evidence in cross-platform release-candidate acceptance.
- Strengthen security, recovery, evaluation, documentation, and public-package release regression coverage.

A provider that has not passed live verification remains configurable but is not marked as officially certified.

## `0.3.0`: phase-two kernel and engineering loop

Phase two advances through `alpha → beta → rc` and strengthens the framework kernel without changing CoreMind's three use paths:

- Align critical dependency versions and isolate low-level implementations behind private adapters.
- Establish durable harness operations that can abort, pause, resume, and recover without duplicating committed effects.
- Improve context selection, compaction evidence, long-output artifacts, and observable metrics.
- Build a first-party Coding/Engineering Kernel for repository understanding, minimal edits, diffs, verification, repair, and regression.
- Keep outcomes, events, approvals, and recovery consistent across TUI, headless CLI, TypeScript SDK, and Python SDK.
- Ship tests, SOP, Skill, bilingual guides, examples, migration, and rollback guidance with every batch.

`0.3.0-rc.1` has completed Batches 0 through 5 plus the automated closure for Batch 6: critical dependencies use one exact family behind private adapters; runs have a durable operation envelope, atomic RunState, Session backend conformance, backed-up migration, and non-replay boundaries for uncertain effects; long tasks add stable context prefixes, deterministic compaction evidence, truthful cache metrics, and controlled workspace artifacts; coding is a first-party Engineering Kernel inside the Runtime; and the extension surface is limited to four controlled lifecycle events with traceable experiments, a seven-check provider contract, TUI evidence views, and one shared `RunSnapshot` across all entry points. Local gates pass for P01-P19, npm packages, the wheel, the source archive, modules, and Markdown. `alibaba-model-studio/qwen-plus` also completed the seven-check live revalidation. Releases and registries remain the source of truth for public availability and final release assets.

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
