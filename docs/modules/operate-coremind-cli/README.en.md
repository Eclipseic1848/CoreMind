# CLI and TUI

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Provide a beginner end-to-end path through create, run, chat, check, eval, doctor, and templates, with run --resume for unfinished runs that have a safe recovery boundary.

## Public interfaces

- `coremind create`
- `coremind run --resume`
- `coremind chat`
- `coremind check`
- `coremind eval`
- `coremind doctor`
- `coremind templates`

## Errors and boundaries

- Failed commands return a non-zero exit code
- Non-TTY approvals deny safely
- TUI and readline share the same ChatSession harness
- Unsafe or already-finished run IDs fail resume explicitly

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-cli/src](../../../packages/coremind-cli/src)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)
- [Module example](../../../examples/modules/operate-coremind-cli/README.en.md)
- [Agent Skill](../../../skills/operate-coremind-cli/SKILL.md)
