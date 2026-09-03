# TypeScript SDK

Status: published with stable `0.7.0`. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Embed runtime, tools, sessions, explicit Loops, evaluation, and events in Node applications through the single coremind-ai facade.

## Public interfaces

- `CoreMindRuntime`
- `ChatSession`
- `defineTool`
- `checkProject`
- `runEvaluationSuite`
- `LoopConfig` / `LoopPhase`
- `RunSnapshot` / `createRunSnapshot`
- Public lifecycle-extension and lightweight-experiment contracts

## Errors and boundaries

- `runtime.run()` and `ChatSession.chat()` return failure, pause, abort, timeout, and budget exhaustion through `RunResult.outcome`; callers do not need exceptions for run terminal states
- Pre-run creation and configuration failures still use `CoreMindError.code`
- `defineTool` requires a structured `effect` declaration
- `loop_state`, RunOutcome, stable snapshots, and effect receipts share the same runtime semantics as CLI and Python
- The facade only re-exports and never duplicates business logic
- `RunResult.snapshot` is pure JSON. Protocol fully validates terminal state, metrics, trace, checkpoints, artifacts, and extension receipts to reject cross-language structural drift

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind/src/index.ts](../../../packages/coremind/src/index.ts)
- [packages/coremind-runtime/src/public-tool.ts](../../../packages/coremind-runtime/src/public-tool.ts)
- [packages/coremind/src/index.test.ts](../../../packages/coremind/src/index.test.ts)
- [packages/coremind-runtime/src/public-tool.test.ts](../../../packages/coremind-runtime/src/public-tool.test.ts)
- [模块示例](../../../examples/modules/embed-coremind-typescript/README.zh-CN.md)
- [Module example](../../../examples/modules/embed-coremind-typescript/README.en.md)
- [Agent Skill](../../../skills/embed-coremind-typescript/SKILL.md)
