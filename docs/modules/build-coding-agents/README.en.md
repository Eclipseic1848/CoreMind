# Coding Agents

Status: unpublished `0.3.0` stable candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

Turn “reproduce the defect → locate the cause → make the smallest change → run the target test → run regression tests → inspect the diff” into a controlled workflow that beginners can verify.

This capability is now a first-party Engineering Kernel inside the Runtime rather than an example composition. It does not introduce a second runtime. CLI, TypeScript SDK, Python SDK, and source usage share the same harness, loop, permissions, budgets, sessions, context, traces, checkpoints, evaluation, and terminal semantics.

## Public interfaces

- `inspectCodingRepository`: performs bounded, read-only detection of TypeScript, JavaScript, Python, package managers, and test commands; detection is advisory only.
- `selectCodingEnvironment`: requires an explicit user choice when language, package manager, or test command is ambiguous.
- `buildRepositoryMap` and `createEngineeringTaskPlan`: create a repository map and the six-phase understand → plan → modify → verify → repair → deliver workflow.
- `createEngineeringKernelDefinition`: creates a bounded verify/repair definition that reuses the shared `LoopController` and enables the Runtime evidence gate by default.
- `engineering_evidence` events: Runtime derives delivery evidence from actual tool execution, exit codes, checkpoints, and `git_diff`. Model output `PASS` is necessary but never sufficient.
- `EngineeringEvidenceLedger`: retained only as a legacy external-evidence import compatibility layer. New code must not fill it manually to claim success.
- `ProcessRunner`: runs a command plus argument array with timeout, cancellation, output limits, and controlled environment variables.
- `GitAdapter`: exposes read-only `status`, `diff`, and `log` without arbitrary Git subcommands or mutations.
- `createUnifiedDiff` and `diffFiles`: create unified diffs with input, output, and complexity limits.
- `runEvaluationSuite`: runs schemaVersion 1 or 2 evaluation scenarios.
- `OutcomeGrader`, `TrajectoryGrader`, `CommandGrader`, `FileGrader`, `DiffGrader`, `StateGrader`, and `ResponseGrader`.

## Security boundaries

- Prefer path-aware `read`, `edit`, and `write` tools plus read-only Git tools.
- Every `edit` or `write` change must reference a pre-write checkpoint. Process and network access continue through the shared permission policy.
- Detection never chooses the project entry on the user's behalf. Mixed languages, multiple lock files, or unknown test commands become explicit decisions.
- On Windows, the host shell opens only when `mode: full`, `workspaceOnly: false`, and `network: allow` are all selected. This records explicit acceptance of host-process boundaries; it does not provide operating-system isolation.
- The built-in Linux shell fails closed when its isolation layer is unavailable and never falls back to the host shell.
- Evaluation captures the dirty-worktree baseline before execution and preserves pre-existing user changes by default.
- Checkpoints, diffs, traces, and restore remain active in full mode.
- Runtime Trace stores only the command SHA-256, test-command classification, exit code, and duration; it never persists command text or credentials.
- This module never performs `git commit`, `git push`, publication, deletion, or other scope expansion automatically.

## Verified evidence

- One real single-file TypeScript defect repository and one real single-file Python defect repository pass deterministic offline evaluation.
- Both languages also cover cross-file defects, wrong commands, approval denial, abort, checkpoint diff, and restore. A test that did not run or failed cannot be reported as passed.
- Both language cases must observe the initial failure, make a minimal edit, and pass target and full regression tests.
- The live-model matrix ran each language five times; capability and safety gates reached 5/5. The public repository retains reproducible evaluation scenarios, while raw runs are archived with candidate acceptance evidence.
- Property tests cover path escape, permission combinations, stable terminal results, cancellation, and repeated-action limits.

## Source, tests, and examples

- [ProcessRunner](../../../packages/coremind-tools/src/process-runner.ts)
- [Read-only GitAdapter](../../../packages/coremind-tools/src/git-adapter.ts)
- [Unified diff](../../../packages/coremind-tools/src/unified-diff.ts)
- [Evaluation graders](../../../packages/coremind-runtime/src/evaluation-graders.ts)
- [Engineering Kernel](../../../packages/coremind-runtime/src/coding/engineering-kernel.ts)
- [Kernel contract tests](../../../packages/coremind-runtime/src/coding/engineering-kernel.test.ts)
- [Runtime evidence gate](../../../packages/coremind-runtime/src/coding/runtime-engineering-evidence.ts)
- [Real-defect examples](../../../examples/coding-evals/README.en.md)
- [Module example](../../../examples/modules/build-coding-agents/README.en.md)
- [Agent Skill](../../../skills/build-coding-agents/SKILL.md)
