# Workflows and Explicit Bounded Loops

Status: unpublished `0.3.0` stable candidate. Supported platforms: Windows and Linux. macOS is not yet officially supported.

## Purpose

This module helps developers without Loop Engineering experience choose correctly between fixed orchestration and verified convergence. Failures, pauses, resumes, retries, and effects remain observable and reviewable.

| Mode | Use it when | Framework guarantee |
|---|---|---|
| Basic agent loop | One agent decides whether to continue calling tools | Shared budgets, permissions, trace, and terminal results; no business-quality convergence claim |
| `workflow` | Steps and dependencies are known before execution | Sequence, parallelism, conditions, bounded retries, and stable-step resume |
| `loop` | The task requires generate, verify, repair, and re-verify | Explicit states, bounded repair, no-progress detection, pause-resume, and exhaustion failure |

`workflow` and `loop` are mutually exclusive. Do not choose a Loop merely to appear more autonomous; keep deterministic rules in normal code, tools, or a Workflow.

## Public interfaces and states

- Configuration: `LoopConfig`, `LoopActionConfig`, and `LoopVerificationConfig`
- Execution: `LoopController`, `LoopRunner`, and `Orchestrator`
- Resume: `prepareRunResume`, `RunStateJournal`, and effect receipts
- States: `planning`, `executing`, `verifying`, `repairing`, `paused`, plus success, failure, abort, timeout, and budget-exhaustion terminals

The internal state-machine dependency stays behind `LoopController` and is not part of configuration, protocol, or SDK contracts. Every dependency upgrade must rerun transition, snapshot, cancellation, and event-order contracts.

## Reliability and effect boundaries

- A failed verification must repair, pause, or fail; it cannot return success.
- `maxIterations`, `maxRepairs`, `maxRepeatedAction`, global budgets, and timeouts bound execution.
- Only confirmed transient provider or network errors retry. Approval denials, security denials, invalid arguments, and deterministic business failures do not retry blindly.
- Tool effects receive `started`, `committed`, or `unknown` receipts. Resume does not replay committed effects, while unknown effects pause for human reconciliation.
- A snapshot represents a stable CoreMind business state, not an arbitrary call stack or in-flight external request.
- `full` reduces per-action prompts but never disables explicit deny rules, budgets, traces, checkpoints, receipts, or resume checks.

## Source, tests, and examples

- [Loop configuration schema](../../../packages/coremind-config/src/schema/loop.ts)
- [LoopController](../../../packages/coremind-runtime/src/loop-controller.ts)
- [LoopRunner](../../../packages/coremind-runtime/src/loop-runner.ts)
- [Retry classification](../../../packages/coremind-runtime/src/retry-policy.ts)
- [Module example](../../../examples/modules/design-workflows/README.en.md)
- [Verified repair golden example](../../../examples/golden/verified-repair-loop/README.en.md)
- [Development SOP](SOP.en.md)
- [Reusable Skill](../../../skills/design-workflows/SKILL.md)

CoreMind owns execution mechanisms and quality evidence. Users or business owners retain control of goals, verification rules, approval ownership, and final acceptance.
