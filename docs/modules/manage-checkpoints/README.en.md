# Checkpoints, Diffs, and Restore

Status: contract and documentation aligned with the stable `0.7.1` release line. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Snapshot files before edit/write, expose diff and explicit restore, and mark unguaranteed side effects as non-reversible.

## Public interfaces

- `CheckpointManager`
- `inspectCheckpoint`
- `restoreCheckpoint`
- Protocol v2 `checkpoint` actions: `list`, `create`, `diff`, and `restore`

## Errors and boundaries

- checkpoint_too_large: block a write that exceeds the snapshot limit
- checkpoint_not_reversible: refuse fake recovery
- checkpoint_corrupt: invalid record
- checkpoint_conflict: a later user or concurrent edit changed the file, so restore refuses to overwrite it

`edit` and `write` snapshot the original file before execution and record the expected post-tool fingerprint after execution. Restore proceeds only while the current file still matches that expected state. This is optimistic concurrency protection, not a transaction for arbitrary side effects.

Protocol v2 checkpoint writes share the Worker's single-writer transition boundary and require an `operationId`, so retries are idempotent and conflicting reuse fails closed.

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/checkpoint.ts](../../../packages/coremind-runtime/src/checkpoint.ts)
- [packages/coremind-runtime/src/checkpoint.test.ts](../../../packages/coremind-runtime/src/checkpoint.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/manage-checkpoints/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-checkpoints/README.en.md)
- [Agent Skill](../../../skills/manage-checkpoints/SKILL.md)
