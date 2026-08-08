# Configuration and Schema

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Describe agents, tools, workflows, budgets, permissions, and quality profiles in one validated coremind.yaml file.

## Public interfaces

- `loadConfigFile`
- `parseConfigText`
- `parseAndValidate`
- `validateConfig`

## Errors and boundaries

- ConfigParseError: unreadable file or invalid YAML/JSON
- ConfigValidationError: configuration does not satisfy the v2 schema

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-config/src](../../../packages/coremind-config/src)
- [packages/coremind-config/src/parse.test.ts](../../../packages/coremind-config/src/parse.test.ts)
- [packages/coremind-config/src/validate.test.ts](../../../packages/coremind-config/src/validate.test.ts)
- [模块示例](../../../examples/modules/configure-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/configure-coremind/README.en.md)
- [Agent Skill](../../../skills/configure-coremind/SKILL.md)
