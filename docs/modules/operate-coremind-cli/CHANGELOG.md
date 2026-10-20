# Changelog

## Unreleased

- 修复 `doctor <配置文件>` 对合法匿名/Header-only 自定义 Provider 的无关 API key 误报，复用所选 Provider 的既有凭据校验；显式缺失凭据仍失败，内置鉴权和无配置通用诊断保持不变。检查不加载项目脚本、不发 Provider 请求，不证明凭据有效、真实连通或认证（#332）。
- Fix unrelated API-key failures in `doctor <config-file>` for legitimate anonymous/Header-only custom Providers by reusing the selected Provider's existing credential checks. Explicit missing credentials still fail; built-in authentication and general diagnostics without a config remain unchanged. Checks neither load project scripts nor send Provider requests and do not establish credential validity, connectivity, or certification (#332).
- 修复 readline `/exit`、`!exit`：与 TUI 一致，先请求取消活动 Run 并等待收尾；普通管道 EOF 仍自然完成，空闲退出、审批及 MCP 登录等待行为保持不变（#331）。
- Fix readline `/exit` and `!exit` to match the TUI by requesting active-Run cancellation before waiting for cleanup. Ordinary piped EOF still completes naturally, while idle-exit, approval-wait, and MCP-login-wait behavior remains unchanged (#331).

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## Unreleased — 1.1 development

- Added explicit TTY MCP login before run and single-owner chat login/cancel/logout, including cancellation and local revocation during tool approval; machine-output modes reject interaction.

- Documented `/steer` and `/follow-up` in TUI/readline, including approval command mode and unchanged permission boundaries.
- Clarified one retained busy draft, explicit idle confirmation, unsaved later submissions, and late receipts that preserve newer drafts.
- Linked native input lifecycle and real terminal regression evidence without treating applied receipts as consumption or business completion.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Preserved ordinary input submitted while a Run is busy while keeping `/abort` and `/children` immediately available.

## 0.7.0 - 2026-08-29

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.2 - 2026-08-26

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.1 - 2026-08-21

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0 - 2026-08-13

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0-rc.2 - 2026-08-12

- Added provider discovery, explicit project scaffolding choices, and automated real ConPTY/pseudoterminal acceptance evidence.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2 - 2026-08-11

- Added TUI Artifact and context commands plus recovery, compaction, cache, and evaluation status.
- Added the shared pure-JSON `RunSnapshot` to the final CLI JSONL result.

## 0.2.0-rc.1 - 2026-08-09

- Added stable terminal exit codes and a final JSONL `run_result` event with stderr-only diagnostics.
- Made `--print` and `--json-events` mutually exclusive to keep machine output deterministic.
- TUI now displays failed terminal reasons and structured approval details without hiding critical targets behind long content.
- TUI, readline, and JSONL now expose the same explicit Loop state order, and `run --resume` continues safe paused runs without replaying committed effects.
- `doctor <config-file>` now validates the configured `provider.apiKeyEnv` (including the Alibaba default) rather than reporting unrelated fixed-list keys as missing.

## 0.2.0-beta.2 - 2026-08-08

- Fixed busy-state `/abort` handling and explicit validation for `--session` when persistence is disabled.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for CLI and TUI.
