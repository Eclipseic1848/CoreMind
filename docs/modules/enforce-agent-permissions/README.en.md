# Permissions and Security

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Enforce ask, assisted, and full approval modes while distinguishing path-aware file tools, the Linux bash OS sandbox, and Windows shell risk boundaries.

## Public interfaces

- `ToolPolicy`
- `ApprovalQueue`
- `ToolApprovalRequest`
- `ToolEffect`
- `createLinuxSandboxedBashTool`

## Errors and boundaries

- Missing approval handlers deny safely
- A human denial blocks that call and later unapproved calls in the same batch, then pauses after batch reconciliation. It is not fed back as an ordinary recoverable tool error, so the model cannot request another approval in the same run. A sequential workflow saves no output for the denied step and starts no later step.
- Explicit deny and escaped paths for path-aware file tools remain blocked in full mode
- Nested path and URL arguments are inspected recursively; approval UI shows effects, complete targets, and reasons first
- The Windows host shell opens only when `mode: full`, `workspaceOnly: false`, and `network: allow` are all selected; every other combination fails closed
- Git Bash discovery provides command compatibility rather than operating-system isolation
- Arbitrary shell side effects are never claimed as automatically reversible
- Linux bash currently denies network access and fails closed when the sandbox is unavailable

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/tool-policy.ts](../../../packages/coremind-runtime/src/tool-policy.ts)
- [packages/coremind-cli/src/approval.ts](../../../packages/coremind-cli/src/approval.ts)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-tools/src/host-shell.ts](../../../packages/coremind-tools/src/host-shell.ts)
- [packages/coremind-runtime/src/tool-policy.test.ts](../../../packages/coremind-runtime/src/tool-policy.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [packages/coremind-tools/src/host-shell.test.ts](../../../packages/coremind-tools/src/host-shell.test.ts)
- [模块示例](../../../examples/modules/enforce-agent-permissions/README.zh-CN.md)
- [Module example](../../../examples/modules/enforce-agent-permissions/README.en.md)
- [Agent Skill](../../../skills/enforce-agent-permissions/SKILL.md)
