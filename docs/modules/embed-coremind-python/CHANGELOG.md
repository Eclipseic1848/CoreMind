# Changelog

## Unreleased

- 修复 v1 `@client.tool` 对 future/字符串 `int`、`str`、`bool` 和已有容器参数注解的自动 Schema；Node 侧保留既有类型转换，转换后仍未通过 Schema 校验的参数在执行前拒绝。无法解析的前向引用明确要求显式 `parameters`，既有显式 Schema 保持兼容，复杂 typing 支持范围不扩大（#326）。
- Fix v1 `@client.tool` automatic schemas for future/string `int`, `str`, `bool`, and existing container parameter annotations. Node preserves existing type conversion and rejects arguments that still fail schema validation before execution. Unresolvable forward references explicitly require `parameters`; existing explicit schemas remain compatible without expanding complex typing support (#326).

## 1.2.0 - 2026-10-17

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.1.0 - 2026-10-15

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## Unreleased — 1.1 development

- Added negotiated v2 MCP login/cancel/logout with dedicated non-secret notifications, caller-thread sync handlers, original-loop async handlers, and Node cancellation cleanup. Default v1 remains non-interactive.

## 1.0.1 - 2026-09-25

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 1.0.0 - 2026-09-24

- Synchronized the module contract, version metadata, and bilingual guidance with the current stable release.

## 0.8.0 - 2026-09-08

- Synchronized the module contract, version metadata, and bilingual guidance with the 0.8.0 release line.

## 0.7.1 - 2026-09-03

- Classified the stable Python package as Production/Stable and synchronized the bundled Worker manifest with the Python package version.

## 0.7.0 - 2026-08-29

- Added a versioned worker manifest with protocol, package-version, and SHA-256 validation before Python launches the bundled worker.

## 0.3.2 - 2026-08-26

- Added a versioned worker manifest with protocol, package-version, and SHA-256 validation before Python launches the bundled worker.

## 0.3.1 - 2026-08-21

- Added a versioned worker manifest with protocol, package-version, and SHA-256 validation before Python launches the bundled worker.

## 0.3.0 - 2026-08-13

- Added a versioned worker manifest with protocol, package-version, and SHA-256 validation before Python launches the bundled worker.

## 0.3.0-rc.2 - 2026-08-12

- Added a versioned worker manifest with protocol, package-version, and SHA-256 validation before Python launches the bundled worker.

## 0.3.0-rc.1 - 2026-08-12

- Synchronized this module contract with the repository release candidate.
- Added no module-specific product behavior during the Batch 6 release-candidate closure.

## 0.3.0-beta.2 - 2026-08-11

- Added strict validation for the shared pure-JSON `RunSnapshot` and stable `invalid_run_snapshot` errors.
- Verified snapshot and terminal parity against TypeScript while retaining the bundled Node Worker architecture.

## 0.2.0-rc.1 - 2026-08-09

- Python custom tools now send mandatory structured effect declarations through the protocol.
- Python receives the same unified terminal outcome semantics as TypeScript and CLI.
- Initialization and tool-registration failures now terminate the partially started worker before returning an exception.
- Added explicit Loop state-order and terminal-result parity with TypeScript, including safe paused-run resume and effect-receipt semantics.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Python SDK and Tool Bridge.
