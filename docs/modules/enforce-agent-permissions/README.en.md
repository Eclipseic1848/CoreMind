# Permissions and Security

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Enforce ask, assisted, and full approval modes while distinguishing path-aware file tools, the Linux bash OS sandbox, and Windows shell risk boundaries.

## Public interfaces

- `ToolPolicy`
- `ApprovalQueue`
- `ToolApprovalRequest`
- `createLinuxSandboxedBashTool`

## Errors and boundaries

- Missing approval handlers deny safely
- Explicit deny and escaped paths for path-aware file tools remain blocked in full mode
- Arbitrary shell side effects are never claimed as automatically reversible
- Linux bash currently denies network access and fails closed when the sandbox is unavailable

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/tool-policy.ts](../../../packages/coremind-runtime/src/tool-policy.ts)
- [packages/coremind-cli/src/approval.ts](../../../packages/coremind-cli/src/approval.ts)
- [packages/coremind-tools/src/linux-sandbox.ts](../../../packages/coremind-tools/src/linux-sandbox.ts)
- [packages/coremind-runtime/src/tool-policy.test.ts](../../../packages/coremind-runtime/src/tool-policy.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [packages/coremind-tools/src/linux-sandbox.test.ts](../../../packages/coremind-tools/src/linux-sandbox.test.ts)
- [模块示例](../../../examples/modules/enforce-agent-permissions/README.zh-CN.md)
- [Module example](../../../examples/modules/enforce-agent-permissions/README.en.md)
- [Agent Skill](../../../skills/enforce-agent-permissions/SKILL.md)
