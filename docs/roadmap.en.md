# CoreMind Public Roadmap

CoreMind helps newcomers and application engineers build reliable business agents through configuration, one standard runtime, a bounded harness and loop, quality gates, and task-oriented learning materials.

This public roadmap describes product boundaries and intended directions. It deliberately excludes internal schedules, acceptance records, and maintainer working notes. Priorities may change as real users and community contributors provide feedback.

## Current release: `0.2.0-beta.1`

The current public release provides:

- Three use paths: CLI/TUI, TypeScript and Python SDKs, and full source.
- Single-agent and multi-agent execution, workflows, and budget-bounded loops.
- Config v2, 38 configurable model providers, and custom compatible endpoints.
- `ask`, `assisted`, and `full` permission modes with path policy, approvals, audit, checkpoints, diffs, and recovery.
- Explicit outcomes, budgets, traces, sessions, context protection, tests, evaluations, and release gates.
- Eight project templates, four offline golden examples, and 16 capability modules.
- Tests, SOPs, a Skill, bilingual guides, and examples for every capability module.
- Windows and Linux automation plus public releases on GitHub, npm, PyPI, and the bilingual documentation site.

The current release is in Beta. You are welcome to evaluate it in development and test environments and help improve it through community feedback.

## `0.2.x`: phase-one stabilization

The stabilization line focuses on reliability and usability of the delivered scope:

- Continue improving the Windows and Linux TUI experience and terminal compatibility.
- Fix installation, configuration, diagnostics, and interaction issues found during initial community use.
- Expand provider certification backed by real invocation evidence.
- Continue cross-language checks for CLI, TypeScript SDK, and Python SDK outcomes and events.
- Strengthen security, recovery, evaluation, documentation, and public-package release regression coverage.

A provider that has not passed live verification remains configurable but is not marked as officially certified.

## Phase two: Web development environment

Phase two is planned to add a complete browser-based development experience:

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
