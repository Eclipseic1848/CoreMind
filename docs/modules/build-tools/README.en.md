# Tools and Business Capabilities

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.

## Public interfaces

- `buildTools`
- `defineTool`
- `adaptCoreMindTool`

## Errors and boundaries

- Tool loading failures are warned and skipped
- Tool exceptions enter tool_result and failure budgets
- Escaped paths or deny rules block execution
- Linux bash fails closed when sandbox initialization fails and never falls back to the host shell

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-tools/src](../../../packages/coremind-tools/src)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind-tools/src/registry.test.ts](../../../packages/coremind-tools/src/registry.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)
- [Module example](../../../examples/modules/build-tools/README.en.md)
- [Agent Skill](../../../skills/build-tools/SKILL.md)
