# Agent Construction

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Build isolated agent instances from a focused system prompt, model options, tools, and skills.

## Public interfaces

- `buildAgent`
- `CoreMindRuntime.create`
- `buildAgentFromConfig`

## Errors and boundaries

- unknown_agent: the selected agent does not exist
- agent_failed: upstream stopReason:error or model failure

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/agent-factory.ts](../../../packages/coremind-runtime/src/agent-factory.ts)
- [packages/coremind-runtime/src/runtime.ts](../../../packages/coremind-runtime/src/runtime.ts)
- [packages/coremind-runtime/src/agent-factory.test.ts](../../../packages/coremind-runtime/src/agent-factory.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/design-agents/README.zh-CN.md)
- [Module example](../../../examples/modules/design-agents/README.en.md)
- [Agent Skill](../../../skills/design-agents/SKILL.md)
