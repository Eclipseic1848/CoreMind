# Templates and Project Guidance

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Generate language-aware code skeletons, tests, evaluations, bilingual documentation, SOPs, and a project skill without overwriting existing files.

## Public interfaces

- `detectProjectLanguage`
- `scaffoldProjectGuidance`
- `coremind create`

## Errors and boundaries

- Mixed or empty projects do not guess a language
- wx writes preserve existing files
- Unknown business rules remain explicit owner-confirmation items

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-templates/src/project-scaffold.ts](../../../packages/coremind-templates/src/project-scaffold.ts)
- [packages/coremind-templates/templates](../../../packages/coremind-templates/templates)
- [packages/coremind-templates/src/project-scaffold.test.ts](../../../packages/coremind-templates/src/project-scaffold.test.ts)
- [packages/coremind-templates/src/templates.test.ts](../../../packages/coremind-templates/src/templates.test.ts)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [模块示例](../../../examples/modules/scaffold-coremind-projects/README.zh-CN.md)
- [Module example](../../../examples/modules/scaffold-coremind-projects/README.en.md)
- [Agent Skill](../../../skills/scaffold-coremind-projects/SKILL.md)
