# CLI and TUI

Status: contract and documentation aligned with the `1.0.0` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Provide a beginner end-to-end path through create, run, chat, check, eval, doctor, and templates, display explicit Loop progress, and use run --resume for paused or interrupted runs with a safe boundary.

## Public interfaces

- `coremind create`
- `coremind run --resume`
- `coremind chat`
- Chat `/steer text` and `/follow-up text` (1.1 development, same active Run)
- `coremind check`
- `coremind eval`
- `coremind doctor`
- `coremind templates`

## Errors and boundaries

- Stable `run` exit codes: succeeded `0`, failed `1`, paused `2`, budget exhausted `3`, timeout `124`, and aborted `130`
- `--json-events` keeps stdout as JSONL and always ends with `run_result`; diagnostics go to stderr
- `--print` and `--json-events` are mutually exclusive so prose cannot contaminate machine output
- Non-TTY approvals deny safely
- TUI and readline share the same ChatSession harness, and failed terminal states display their reason
- TUI keeps one editable busy draft; Enter sends it only after the Run becomes idle. Readline keeps the first submitted busy draft, reports later submissions as unsaved, and never overwrites or executes it automatically. Once idle, edit a prefilled draft and confirm, or use a blank line to confirm the saved draft without prefill
- TUI and readline support `/steer text` and `/follow-up text`; empty bodies show usage. Controls target the Run captured at call time; unready, sealed, or wrong Runs reject them. Both retain `/abort`; TUI also retains `/children`
- During tool approval, explicit controls do not approve tools. TUI uses `/` to enter command mode and Esc to return; y/n inside commands are not approval answers. Permission modes and deny rules remain unchanged
- Five-state control receipts do not prove consumption; separate `input_*` events show claim/completion/discard. Late receipts identify the original Run/controlId without clearing newer drafts. Controls start no concurrent Run
- TUI approvals show effects, complete targets, and reasons first; long bodies are summarized and credential fields redacted
- TUI, readline, and JSONL expose the same ordered `loop_state` events; pause exits with code `2` and remains resumable
- Unsafe or already-finished run IDs fail resume explicitly
- TUI `/status`, `/artifacts`, and `/context` show recovery, evaluation, artifact, cache, and compaction status
- The final JSONL `run_result.snapshot` is the same pure-JSON snapshot used by the TypeScript and Python SDKs

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-cli/src](../../../packages/coremind-cli/src)
- [packages/coremind-cli/src/cli.e2e.test.ts](../../../packages/coremind-cli/src/cli.e2e.test.ts)
- [packages/coremind-cli/src/approval.test.ts](../../../packages/coremind-cli/src/approval.test.ts)
- [Readline controls and drafts](../../../packages/coremind-cli/src/commands/chat.ts) and [regressions](../../../packages/coremind-cli/src/commands/chat.test.ts)
- [TUI](../../../packages/coremind-cli/src/tui.tsx), [regressions](../../../packages/coremind-cli/src/tui.test.tsx), and [real terminal acceptance](../../../scripts/tty-acceptance.mjs)
- [模块示例](../../../examples/modules/operate-coremind-cli/README.zh-CN.md)
- [Module example](../../../examples/modules/operate-coremind-cli/README.en.md)
- [Agent Skill](../../../skills/operate-coremind-cli/SKILL.md)
