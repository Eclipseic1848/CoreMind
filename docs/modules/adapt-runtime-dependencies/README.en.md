# Runtime Dependency Adapters

This module targets the `1.4.0` release line and supports Windows and Linux.

## Purpose

Keep model streaming, messages, tools, usage, and error classification behind private CoreMind adapter seams so application code never depends on low-level implementation details. Critical dependencies must use one exact version family, and CI blocks drift.

## Public interfaces

- `inspectRuntimeCompatibility()` returns the dependency family, adapter version, error-mapping version, and capabilities in a CoreMind-owned structure.
- `coremind doctor` shows compatibility status without adding low-level version fields to user configuration.
- `CoreMindMessage` and `CoreMindToolDefinition` keep the public SDK contract CoreMind-owned; private runtime dependency types do not appear in root declarations.

## Invariants

- The installed critical dependency tree contains exactly one version family. Version 1.4.0 pins all eight underlying runtime dependency members to 1.5.0, including the new tool argument validation package.
- Provider, tool, abort, usage, error, and timeout behavior is covered by explicit conversion or contract tests.
- CoreMind continues to return the stable `session.dir/<id>.jsonl` path; an internal repository layout cannot rewrite the CLI/SDK file contract.
- Double casts may not conceal cross-version type conflicts.
- SDK dependency resolution follows the consumer's install graph. Release validation checks all eight family members and official transitive versions after a clean tarball installation without repository overrides, then runs import, Child Run, and package-content checks.
- The bundled Python Worker's manifest records all eight members' actual installed versions, locked archive integrity, and `bundled` output status. It records bundle participation separately from package resolution. Wheel validation compares the Worker and manifest byte-for-byte with frozen source. Consumer npm graphs and the bundled Worker are verified separately.
- A failed upgrade rolls back as one family; mixed versions never enter the main line.
- Candidate baseline capture scans the `coremind-runtime` and `coremind-ai` declaration rollups and blocks private dependency type leaks.

## Source, tests, and evidence

- [Runtime adapter](../../../packages/coremind-runtime/src/dependency-adapter.ts)
- [Session compatibility adapter](../../../packages/coremind-runtime/src/session.ts)
- [Tool registry](../../../packages/coremind-tools/src/registry.ts)
- [Lockstep test](../../../scripts/dependency-lockstep.test.ts)
- [Dependency report test](../../../scripts/dependency-report.test.ts)
- [Dependency upgrade spike template](DEPENDENCY-UPGRADE-SPIKE-TEMPLATE.en.md)
- [Candidate dependency report](../../../baselines/0.3.0-candidate/dependency-report.json)
- [Module example](../../../examples/modules/adapt-runtime-dependencies/README.en.md)
- [中文示例](../../../examples/modules/adapt-runtime-dependencies/README.zh-CN.md)
- [Agent Skill](../../../skills/adapt-runtime-dependencies/SKILL.md)

CoreMind owns adapters, runtime contracts, and quality gates. The business owner still owns model choice, data boundaries, cost, and final acceptance.
