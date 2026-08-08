# TypeScript SDK

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Embed runtime, tools, sessions, evaluation, and events in Node applications through the single coremind-ai facade.

## Public interfaces

- `CoreMindRuntime`
- `ChatSession`
- `defineTool`
- `checkProject`
- `runEvaluationSuite`

## Errors and boundaries

- Public failures use CoreMindError.code
- The facade only re-exports and never duplicates business logic

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind/src/index.ts](../../../packages/coremind/src/index.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-typescript/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-typescript/SKILL.md)
