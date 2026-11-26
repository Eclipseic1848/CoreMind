# Skill and SOP Loading

Version 2.0.0 already supported project Skills and reusable resources. The 2.1.0 npm templates package provides a pinned installer. The module supports Windows and Linux.

## Purpose

Select reusable procedures by agent `skills` IDs. Built-ins and legacy README skills retain full prefix injection. Project `SKILL.md` files first supply an index, then `load_skill({id})` returns their bodies on demand. Resource packages supply declared files through `load_skill({id, resource})`. Business facts remain in project documentation.

A Skill-only project needs a working agent, a `skills/<id>/SKILL.md` file under the configuration directory, and that ID in the agent’s `skills` list. You can author and update the Skill directly. The Runtime supplies `load_skill` for standard Skills, so this setup needs no business tool, knowledge store, Hindsight, or ontology service. See the [minimal project and removal steps](GUIDE.en.md).

## Public interfaces

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

Applications use the existing Runtime to load standard skills. Use the `coremind-skill-install` command from `coremind-templates@2.1.0` to install a pinned Git version into a project. See the [installation and rollback guide](GUIDE.en.md#pinned-installation-and-rollback).

## Errors and boundaries

- Missing skills warn and continue without pretending to load
- Built-ins take precedence on ID collisions; SKILL.md wins over README.md with a warning, and invalid standard files never fall back
- Each project source file is limited to 256 KiB; each resolver result and the snapshot across all agents are separately limited to 2 MiB of serialized UTF-8 JSON
- Only explicitly selected IDs under the configuration `configDir` are resolved; boundary violations, read-time changes, and invalid encoding fail explicitly
- `coremind.skill.json` lists readable resources and their raw-byte SHA-256 digests. Declared paths and targets pass boundary checks. Scripts are available as text
- Loading passes through ToolPolicy, approvals, and budgets. Bodies and resources removed from the final working set can reload from the original snapshot

Standard skills use versioned frozen content in Runtime, Child execution, and resume. A new Runtime reads the current installed version. The raw Store holds bodies and resources. Public projections and exports strip private skill fields. Full conversation recovery also requires Session and compaction records. SHA digests verify consistency.

See the [skills guide](../../en/guide/03-skills.md) for formats, raw 64-character hexadecimal SHA values, and recovery boundaries.

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [Standard resolver](../../../packages/coremind-templates/src/standard-skills.ts) and [parser regressions](../../../packages/coremind-templates/src/standard-skills.test.ts)
- [Snapshot and loading helper](../../../packages/coremind-runtime/src/skill-runtime.ts) and [unit tests](../../../packages/coremind-runtime/src/skill-runtime.test.ts)
- [Runtime acceptance](../../../packages/coremind-runtime/src/skills-runtime.acceptance.test.ts)
- [Pinned installer regression](../../../examples/modules/package-agent-skills/install-skill.test.mjs)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
