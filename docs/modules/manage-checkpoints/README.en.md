# Checkpoints, Diffs, and Restore

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Snapshot files before edit/write, expose diff and explicit restore, and mark unguaranteed side effects as non-reversible.

## Public interfaces

- `CheckpointManager`
- `inspectCheckpoint`
- `restoreCheckpoint`

## Errors and boundaries

- checkpoint_too_large: block a write that exceeds the snapshot limit
- checkpoint_not_reversible: refuse fake recovery
- checkpoint_corrupt: invalid record

CoreMind supplies mechanisms, quality guardrails, and development guidance. Users or business owners retain control of goals, rules, data fields, approval ownership, and final acceptance.

## Source, tests, and examples

- [packages/coremind-runtime/src/checkpoint.ts](../../../packages/coremind-runtime/src/checkpoint.ts)
- [packages/coremind-runtime/src/checkpoint.test.ts](../../../packages/coremind-runtime/src/checkpoint.test.ts)
- [packages/coremind-runtime/src/runtime.test.ts](../../../packages/coremind-runtime/src/runtime.test.ts)
- [模块示例](../../../examples/modules/manage-checkpoints/README.zh-CN.md)
- [Module example](../../../examples/modules/manage-checkpoints/README.en.md)
- [Agent Skill](../../../skills/manage-checkpoints/SKILL.md)
