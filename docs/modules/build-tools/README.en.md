# Tools and Business Capabilities

Status: contract and documentation aligned with the stable `0.7.1` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Connect deterministic business actions through built-in tools, script tools, or the stable defineTool contract.

## Public interfaces

- `buildTools`
- `defineTool`
- `adaptCoreMindTool`
- `ToolEffectDeclaration`
- `ProcessRunner`
- `GitAdapter`
- `createUnifiedDiff` and `diffFiles`

## Errors and boundaries

- Tool loading failures are warned and skipped
- Tool exceptions enter tool_result and failure budgets
- Escaped paths or deny rules block execution
- A custom tool without `effect` fails at configuration or SDK definition time; restricted modes never guess unknown side effects
- `effect.operations` may combine `read`, `write`, `process`, `network`, and `external`; `reversible` must reflect reality
- Custom tools must not reuse built-in names such as `read`, `write`, or `bash`, which would make permission semantics ambiguous
- Linux bash fails closed when sandbox initialization fails and never falls back to the host shell
- `ProcessRunner` avoids shell concatenation, bounds UTF-8 output and execution time, and controls environment variables. A caller-supplied `env` is authoritative: it is neither re-merged with the host environment nor replaced by the tool execution context
- `GitAdapter` exposes fixed read-only status/diff/log operations without arbitrary subcommands, mutations, or path escape
- Unified diff limits input, output, and computational complexity to prevent oversized files from exhausting the process
- The Windows host shell opens only with full mode, disabled workspace restriction, and allowed network. This is an explicit risk choice, not an isolation claim

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-tools/src](../../../packages/coremind-tools/src)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-tools/src/process-runner.ts](../../../packages/coremind-tools/src/process-runner.ts)
- [packages/coremind-tools/src/git-adapter.ts](../../../packages/coremind-tools/src/git-adapter.ts)
- [packages/coremind-tools/src/unified-diff.ts](../../../packages/coremind-tools/src/unified-diff.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind-tools/src/registry.test.ts](../../../packages/coremind-tools/src/registry.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [packages/coremind-tools/src/process-runner.test.ts](../../../packages/coremind-tools/src/process-runner.test.ts)
- [packages/coremind-tools/src/host-shell.test.ts](../../../packages/coremind-tools/src/host-shell.test.ts)
- [packages/coremind-tools/src/git-adapter.test.ts](../../../packages/coremind-tools/src/git-adapter.test.ts)
- [packages/coremind-tools/src/unified-diff.test.ts](../../../packages/coremind-tools/src/unified-diff.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)
- [Module example](../../../examples/modules/build-tools/README.en.md)
- [Agent Skill](../../../skills/build-tools/SKILL.md)
