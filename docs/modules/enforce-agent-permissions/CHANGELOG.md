# Changelog

## 1.3.0 - 2026-10-20

- 普通业务工具写入前统一保护框架持久状态；保留合法业务文件和宿主恢复接口的既有行为。
- Protect framework-managed persistent state before business-tool writes while preserving legitimate business files and host restore APIs.
- 现存多硬链接文件的普通工具写入失败关闭，执行前复核文件身份；读取与单链接业务文件写入保持原权限。
- Fail closed on business-tool writes to existing files with multiple hard links and recheck before execution; reads and single-link business-file writes retain their existing policy.

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Extended credential-boundary enforcement to common custom Provider header aliases without changing non-sensitive header behavior.

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
- P20 found that repeated model tool calls could reopen approval after a human denial. The Runtime now blocks the denied tool and later unapproved calls in that batch, then pauses without another model request. A sequential workflow saves no output for the denied step and starts no later step. Single-tool, mixed-tool, and two-step workflow regressions assert zero write side effects.

## 0.2.0-rc.1 - 2026-08-09

- Added the explicit Windows host-shell triple gate: full mode, open workspace, and allowed network.
- Added verified Git Bash discovery while documenting that interpreter compatibility is not isolation.

### Earlier candidate work

- Added structured ToolEffect approval context and recursive nested path and URL checks.
- Windows constrained host-shell execution now fails closed with file-tool and WSL2 guidance.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Permissions and Security.
