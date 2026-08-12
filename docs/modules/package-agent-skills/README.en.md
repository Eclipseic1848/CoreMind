# Skill and SOP Loading

Status: \`0.3.0-rc.1\` release candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Package reusable procedures as concise skills and inject them per agent while keeping business facts in project documentation.

## Public interfaces

- `resolveSkills`
- `loadDirectorySkills`
- `SKILLS`

## Errors and boundaries

- Missing skills warn and continue without pretending to load
- Built-in skills take precedence on name collisions

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-templates/src/skills.ts](../../../packages/coremind-templates/src/skills.ts)
- [packages/coremind-templates/skills](../../../packages/coremind-templates/skills)
- [packages/coremind-templates/src/skills.test.ts](../../../packages/coremind-templates/src/skills.test.ts)
- [模块示例](../../../examples/modules/package-agent-skills/README.zh-CN.md)
- [Module example](../../../examples/modules/package-agent-skills/README.en.md)
- [Agent Skill](../../../skills/package-agent-skills/SKILL.md)
