# Changelog

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
