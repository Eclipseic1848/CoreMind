# Coding Agents

Status: implemented-alpha. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Turn “reproduce the defect → locate the cause → make the smallest change → run the target test → run regression tests → inspect the diff” into a controlled workflow that beginners can verify.

This module does not introduce a second runtime. CLI, TypeScript SDK, Python SDK, and source usage share the same harness, loop, permissions, budgets, traces, checkpoints, and terminal semantics.

## Public interfaces

- `ProcessRunner`: runs a command plus argument array with timeout, cancellation, output limits, and controlled environment variables.
- `GitAdapter`: exposes read-only `status`, `diff`, and `log` without arbitrary Git subcommands or mutations.
- `createUnifiedDiff` and `diffFiles`: create unified diffs with input, output, and complexity limits.
- `runEvaluationSuite`: runs schemaVersion 1 or 2 evaluation scenarios.
- `OutcomeGrader`, `TrajectoryGrader`, `CommandGrader`, `FileGrader`, `DiffGrader`, `StateGrader`, and `ResponseGrader`.

## Security boundaries

- Prefer path-aware `read`, `edit`, and `write` tools plus read-only Git tools.
- On Windows, the host shell opens only when `mode: full`, `workspaceOnly: false`, and `network: allow` are all selected. This records explicit acceptance of host-process boundaries; it does not provide operating-system isolation.
- The built-in Linux shell fails closed when its isolation layer is unavailable and never falls back to the host shell.
- Evaluation captures the dirty-worktree baseline before execution and preserves pre-existing user changes by default.
- Checkpoints, diffs, traces, and restore remain active in full mode.
- This module never performs `git commit`, `git push`, publication, deletion, or other scope expansion automatically.

## Verified evidence

- One real TypeScript defect repository and one real Python defect repository pass deterministic offline evaluation.
- Both language cases must observe the initial failure, make a minimal edit, and pass target and full regression tests.
- The live-model matrix ran each language five times; capability and safety gates reached 5/5. Detailed evidence is retained in the Batch 8 delivery report, while the release owner must still complete candidate acceptance.
- Property tests cover path escape, permission combinations, stable terminal results, cancellation, and repeated-action limits.

## Source, tests, and examples

- [ProcessRunner](../../../packages/coremind-tools/src/process-runner.ts)
- [Read-only GitAdapter](../../../packages/coremind-tools/src/git-adapter.ts)
- [Unified diff](../../../packages/coremind-tools/src/unified-diff.ts)
- [Evaluation graders](../../../packages/coremind-runtime/src/evaluation-graders.ts)
- [Real-defect examples](../../../examples/coding-evals/README.en.md)
- [Module example](../../../examples/modules/build-coding-agents/README.en.md)
- [Agent Skill](../../../skills/build-coding-agents/SKILL.md)
