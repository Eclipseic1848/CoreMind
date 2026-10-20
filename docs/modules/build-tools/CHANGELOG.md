# Changelog

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Windows 本地 MCP 在服务执行前绑定专属 Job，关闭时确认整树退出；npm 与 Python 默认 Worker 携带并校验同一私有启动器及完整依赖许可。

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## Unreleased

- 修复内置 `web-fetch`/`web-search` 的错误响应与正文读取失败收尾：等待正文取消/释放的清理尝试结束后才结算本地网络活动，清理异常保留原 HTTP/读取错误；原有成功、取消、权限/网络策略及 `web-fetch` 的 2 MiB 正文上限保持不变（#330）。
- Fix built-in `web-fetch`/`web-search` cleanup for non-2xx responses and body-read failures: await body cancellation/release cleanup attempts before settling local network activity, preserving the original HTTP/read error if cleanup fails. Existing success, cancellation, permissions/network policy, and the `web-fetch` 2 MiB body limit remain unchanged (#330).
- Added explicit host-owned MCP OAuth with S256 callback validation, independently cancellable shared refresh, secure TokenStore injection, dynamic credential filtering, and bounded cleanup across TypeScript, CLI, and Python v2.

- Added fixed-target Streamable HTTP MCP with referenced credentials, DNS-to-socket address validation, bounded transport recovery, and independent request cancellation through the existing Run lifecycle.
- Added lazy HTTP resource list/templates/read tools with exact per-agent URI authorization, bounded text/JSON results and Artifacts, no implicit host dereferencing, and no Child inheritance. Interactive OAuth and token refresh are outside this change.
- Added optional Agent-scoped local stdio tools through the existing Run authorization, budget, durability, and lifecycle boundaries, with static diagnostics and owned-process cleanup.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.7.0 - 2026-08-29

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the stable release.

## 0.3.2 - 2026-08-26

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.1 - 2026-08-21

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0 - 2026-08-13

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.2 - 2026-08-12

- Synchronized the module contract, bilingual guidance, examples, and release metadata with the current release candidate.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.2.0-rc.1 - 2026-08-09

- Added a bounded `ProcessRunner`, read-only `GitAdapter`, and bounded unified diff helpers.
- Added Windows shell selection and fail-closed permission combinations without weakening Linux isolation.
- Added timeout, cancellation, output, environment, path, link, and complexity tests.
- Made caller-supplied host-shell environments authoritative and added deterministic Git Bash, PowerShell fallback, minimal-environment, and execution-context isolation coverage.
- Kept the repository test harness's outer timeout above the tool's own bounded timeout so loaded runners can report the real process outcome instead of a test-harness timeout.

### Earlier candidate work

- Added mandatory structured effect declarations for script, TypeScript, and Python tools, including optional dotted path and URL field selectors.
- Added fail-closed handling for undeclared effects under workspace or network restrictions.
- Rejected custom tools that reuse reserved built-in names.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Tools and Business Capabilities.
