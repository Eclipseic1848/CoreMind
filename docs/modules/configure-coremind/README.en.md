# Configuration and Schema

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Describe agents, tools, a Workflow or explicit Loop, budgets, permissions, and quality profiles in one validated coremind.yaml file.

Every custom script tool must declare read, write, process, network, or external effects through `effect`. Missing declarations fail configuration validation instead of being guessed by the permission layer.

## Public interfaces

- `loadConfigFile`
- `parseConfigText`
- `parseAndValidate`
- `validateConfig`
- `ToolEffectDeclarationSchema`
- `LoopConfigSchema`

## Errors and boundaries

- ConfigParseError: unreadable file or invalid YAML/JSON
- ConfigValidationError: configuration does not satisfy the v2 schema
- Validation rejects simultaneous `workflow` and `loop`, unknown Loop agents, and invalid bounds before execution

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-config/src](../../../packages/coremind-config/src)
- [packages/coremind-config/src/parse.test.ts](../../../packages/coremind-config/src/parse.test.ts)
- [packages/coremind-config/src/validate.test.ts](../../../packages/coremind-config/src/validate.test.ts)
- [模块示例](../../../examples/modules/configure-coremind/README.zh-CN.md)
- [Module example](../../../examples/modules/configure-coremind/README.en.md)
- [Agent Skill](../../../skills/configure-coremind/SKILL.md)
