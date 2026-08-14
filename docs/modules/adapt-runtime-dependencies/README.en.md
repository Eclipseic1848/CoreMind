# Runtime Dependency Adapters

Status: published `0.3.0` stable release. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Keep model streaming, messages, tools, usage, and error classification behind private CoreMind adapter seams so application code never depends on low-level implementation details. Critical dependencies must use one exact version family, and CI blocks drift.

## Public interfaces

- `inspectRuntimeCompatibility()` returns the dependency family, adapter version, error-mapping version, and capabilities in a CoreMind-owned structure.
- `coremind doctor` shows compatibility status without adding low-level version fields to user configuration.
- `CoreMindMessage` and `CoreMindToolDefinition` keep the public SDK contract CoreMind-owned; private runtime dependency types do not appear in root declarations.

## Invariants

- The installed critical dependency tree contains exactly one version family.
- Provider, tool, abort, usage, error, and timeout behavior is covered by explicit conversion or contract tests.
- CoreMind continues to return the stable `session.dir/<id>.jsonl` path; an internal repository layout cannot rewrite the CLI/SDK file contract.
- Double casts may not conceal cross-version type conflicts.
- SDK packages do not use shrinkwrap. CLI and SDK packages share the workspace lockfile, clean-install checks, and tarball-content gates.
- A failed upgrade rolls back as one family; mixed versions never enter the main line.
- Candidate baseline capture scans the `coremind-runtime` and `coremind-ai` declaration rollups and blocks private dependency type leaks.

## Source, tests, and evidence

- [Runtime adapter](../../../packages/coremind-runtime/src/dependency-adapter.ts)
- [Session compatibility adapter](../../../packages/coremind-runtime/src/session.ts)
- [Tool registry](../../../packages/coremind-tools/src/registry.ts)
- [Lockstep test](../../../scripts/dependency-lockstep.test.ts)
- [Dependency report test](../../../scripts/dependency-report.test.ts)
- [Candidate dependency report](../../../baselines/0.3.0-candidate/dependency-report.json)
- [Module example](../../../examples/modules/adapt-runtime-dependencies/README.en.md)
- [中文示例](../../../examples/modules/adapt-runtime-dependencies/README.zh-CN.md)
- [Agent Skill](../../../skills/adapt-runtime-dependencies/SKILL.md)

CoreMind owns adapters, runtime contracts, and quality gates. The business owner still owns model choice, data boundaries, cost, and final acceptance.
