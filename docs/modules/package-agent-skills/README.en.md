# Skill and SOP Loading

Status: documents standard skills and legacy compatibility in the 1.1 development line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Select reusable procedures by agent `skills` IDs. Built-ins and legacy README skills retain full stable-prefix injection. Project SKILL.md files first supply an index, then return bodies through `load_skill` on demand. Business facts remain in project documentation.

## Public interfaces

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

These existing root interfaces are unchanged. Runtime wires standard loading without adding a parser API that applications must call.

## Errors and boundaries

- Missing skills warn and continue without pretending to load
- Built-ins take precedence on ID collisions; SKILL.md wins over README.md with a warning, and invalid standard files never fall back
- Each project source file is limited to 256 KiB; each resolver result and the snapshot across all agents are separately limited to 2 MiB of serialized UTF-8 JSON
- Only explicitly selected IDs under the configuration `configDir` are resolved; boundary violations, read-time changes, and invalid encoding fail explicitly
- Loading still passes through ToolPolicy, approvals, and budgets without granting permissions; bodies removed from the final working set can reload from the original snapshot

Standard skills use frozen content in Runtime, Child execution, and resume; file edits do not hot-reload into an existing Runtime. The trusted raw Store contains bodies, while public projections and exports strip private skill fields. Disabling Session does not imply complete conversation recovery, and consistency hashes are not signatures against host rewrites.

See the [skills guide](../../en/guide/03-skills.md) for formats, raw 64-character hexadecimal SHA values, and recovery boundaries. Remote discovery, script execution, and a skill marketplace are not provided.

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [Standard resolver](../../../packages/coremind-templates/src/standard-skills.ts) and [parser regressions](../../../packages/coremind-templates/src/standard-skills.test.ts)
- [Snapshot and loading helper](../../../packages/coremind-runtime/src/skill-runtime.ts) and [unit tests](../../../packages/coremind-runtime/src/skill-runtime.test.ts)
- [Runtime acceptance](../../../packages/coremind-runtime/src/skills-runtime.acceptance.test.ts)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
