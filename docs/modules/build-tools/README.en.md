# Tools and Business Capabilities

Status: contract and documentation aligned with the `1.0.0` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

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
- Final tool-call JSON must parse completely; string-escape repair may preserve its full content. Otherwise it is rejected before approval, checkpoints, and execution, without completing missing structure or executing a parsed prefix. Rejection produces a bound `not_started` receipt and tool error so the model can resubmit. Valid arguments still pass the original permission and execution gates.
- Escaped paths or deny rules block execution
- A custom tool without `effect` fails at configuration or SDK definition time; restricted modes never guess unknown side effects
- `effect.operations` may combine `read`, `write`, `process`, `network`, and `external`; `reversible` must reflect reality
- Custom tools must not reuse built-in names such as `read`, `write`, or `bash`, which would make permission semantics ambiguous
- Linux bash fails closed when sandbox initialization fails and never falls back to the host shell
- `ProcessRunner` avoids shell concatenation, bounds UTF-8 output and execution time, and controls environment variables. A caller-supplied `env` is authoritative: it is neither re-merged with the host environment nor replaced by the tool execution context
- `GitAdapter` exposes fixed read-only status/diff/log operations without arbitrary subcommands, mutations, or path escape
- Unified diff limits input, output, and computational complexity to prevent oversized files from exhausting the process
- The Windows host shell opens only with full mode, disabled workspace restriction, and allowed network. This is an explicit risk choice, not an isolation claim
- Local MCP tools are selected per agent and authorize connection, listing, and business calls inside the Run. They require explicitly trusted host execution; Child Runs inherit none, and static doctor never starts a service. See the [guide](GUIDE.en.md#local-mcp-services).
- HTTP MCP uses a fixed URL, Header credential references, and actual socket-address validation; it rejects redirects and environment proxies. An optional exact-IP set constrains every address of that endpoint. Existing network approval remains, and business effects are not downgraded. HTTP-only resources require exact per-agent URI sets; empty sets inherit nothing. Resource listing/reading is lazy and never dereferences links or host files. Per-request cancellation preserves other authorized calls. Run shutdown closes local connections, while remote sessions rely on service leases; OAuth, refresh, and automatic business retries are absent. See the [HTTP guide](GUIDE.en.md#controlled-http-mcp-and-resources).

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-tools/src](../../../packages/coremind-tools/src)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-tools/src/process-runner.ts](../../../packages/coremind-tools/src/process-runner.ts)
- [packages/coremind-tools/src/git-adapter.ts](../../../packages/coremind-tools/src/git-adapter.ts)
- [packages/coremind-tools/src/unified-diff.ts](../../../packages/coremind-tools/src/unified-diff.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind-runtime/src/mcp-runtime.ts](../../../packages/coremind-runtime/src/mcp-runtime.ts)
- [packages/coremind-tools/src/registry.test.ts](../../../packages/coremind-tools/src/registry.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [packages/coremind-tools/src/process-runner.test.ts](../../../packages/coremind-tools/src/process-runner.test.ts)
- [packages/coremind-tools/src/host-shell.test.ts](../../../packages/coremind-tools/src/host-shell.test.ts)
- [packages/coremind-tools/src/git-adapter.test.ts](../../../packages/coremind-tools/src/git-adapter.test.ts)
- [packages/coremind-tools/src/unified-diff.test.ts](../../../packages/coremind-tools/src/unified-diff.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [HTTP target and network boundary tests](../../../packages/coremind-tools/src/mcp-http-fetch.test.ts)
- [HTTP protocol transport tests](../../../packages/coremind-tools/src/mcp-http-transport.test.ts)
- [HTTP resource and result tests](../../../packages/coremind-tools/src/mcp-http-client.test.ts)
- [HTTP Runtime authorization tests](../../../packages/coremind-runtime/src/mcp-http-runtime.test.ts)
- [Real HTTP Runtime acceptance](../../../packages/coremind-runtime/src/mcp-http-runtime.acceptance.test.ts)
- [Real HTTP CLI acceptance](../../../packages/coremind-cli/src/mcp-http-cli.acceptance.test.ts)
- [HTTP Python sync/async acceptance](../../../python/tests/test_mcp_http.py)
- [模块示例](../../../examples/modules/build-tools/README.zh-CN.md)
- [Module example](../../../examples/modules/build-tools/README.en.md)
- [Agent Skill](../../../skills/build-tools/SKILL.md)
