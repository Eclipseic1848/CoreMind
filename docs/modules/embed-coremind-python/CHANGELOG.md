# Changelog

## 0.2.0-rc.1 - 2026-08-09

- Python custom tools now send mandatory structured effect declarations through the protocol.
- Python receives the same unified terminal outcome semantics as TypeScript and CLI.
- Initialization and tool-registration failures now terminate the partially started worker before returning an exception.
- Added explicit Loop state-order and terminal-result parity with TypeScript, including safe paused-run resume and effect-receipt semantics.

## 0.1.0-alpha.2 - 2026-08-08

- Established the implementation, tests, bilingual documentation, SOP, guide, reusable Skill, examples, and module manifest for Python SDK and Tool Bridge.
