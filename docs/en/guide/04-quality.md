# Quality and Safety

CoreMind treats quality as an execution constraint, not a final prompt. Reliable agents need bounded loops, visible state, explicit permissions, reproducible evaluation, and honest failure results.

## Development gate

Run these checks before opening a pull request:

```bash
npm run check
npm run test:stability
npm run test:coverage
npm run build
npm run docs:build
npm run release:check-npm
npm run release:test-npm
npm run release:test-source
npm run acceptance:rc
npm run docs:audit
```

Python changes also require the Python test suite, Worker build, wheel build, Twine, and `npm run release:check-wheel`. The wheel gate installs into a clean virtual environment and starts the bundled Worker.

The stability gate runs the complete suite three consecutive times and stops at the first failure. Windows and Linux execute different platform-security tests, so repository floors are tracked per target: Windows is 72.71% lines, 70.66% statements, 80.11% functions, and 63.11% branches; Linux is 73.26% lines, 71.19% statements, 81.00% functions, and 63.23% branches. Both measurements come from target-platform CI for candidate commit `f6ba774`. The generic fallback takes the per-metric minimum of the two officially supported platforms and cannot be weaker than either platform floor. Critical Runtime files retain shared cross-platform floors, including 86.23% ToolPolicy branches. Windows shell discovery uses injected deterministic cases, the integration case supplies an explicit minimal environment, property tests use fixed random seeds, and dedicated regressions cover critical permission branches so machine capabilities and random samples cannot drift coverage. The gate rejects every decrease and reports the remaining gaps to the 80% repository and 90% critical-branch long-term targets without claiming they are already met.

The npm gates perform real packing for every public workspace, reject tests, internal plans, run state, checkpoints, temporary files, and credentials, then run publint, type-resolution, and clean-project installation checks. The source ZIP gate snapshots the current candidate through a temporary Git index without changing the real staging area; a cross-platform decoder checks entries and rejects path traversal before clean installation, build, contract checks, and CLI startup. Windows and Linux evidence is recorded separately; automated Linux CI does not replace manual TUI acceptance in a real TTY.

## Runtime quality loop

A robust run follows a small cycle:

1. Plan the next bounded action.
2. Check permissions and remaining budget.
3. Execute one tool or model step.
4. Record trace and checkpoint state.
5. Evaluate the result against declared gates.
6. Finish, retry, replan, or fail with an explicit reason.

Retries must have a limit and should address a specific recoverable condition. Repeating the same failed request without changed evidence is not recovery.

### Explicit verified Loop

Use `workflow` for fixed dependencies. Use the public `loop` configuration only for a generate, verify, repair, and re-verify cycle. Success requires the verifier's deterministic `passIf` condition; iteration, repair, repeated-action, budget, and timeout limits bound the run.

Confirmed transient provider and network errors may retry. Approval or security denials pause, invalid arguments and deterministic business failures fail, and abort or timeout propagates to the Loop controller with the same terminal meaning. TUI, headless CLI, TypeScript SDK, and Python SDK observe the same ordered states.

Every stable state persists a versioned snapshot. A paused or interrupted run resumes with the same run ID without replaying completed steps. Tool effects receive `started`, `committed`, or `unknown` receipts: committed effects do not replay automatically, while unknown effects require human reconciliation. This is evidence for safe recovery, not a universal exactly-once guarantee.

Context compaction failures emit `context_compaction_failed` rather than silently falling back. The deterministic summary preserves goals, constraints, permissions, modified files, test status, and next steps.

## Security boundaries

- Start in `ask` mode.
- Keep secrets in environment variables.
- Treat model output and external content as untrusted input.
- Restrict file and command tools to the intended workspace.
- Require explicit approval before sending business data to external services.
- Never claim platform isolation that has not been verified.

Linux can provide operating-system isolation for the built-in shell when its prerequisites are available. Windows does not provide an equivalent host-shell sandbox, so execution opens only when full mode, `workspaceOnly: false`, and `network: allow` are all explicit. Every other combination fails closed. Git Bash discovery does not change that boundary. Custom tools require truthful structured effects and remain responsible for their own isolation on every platform.

Runtime, CLI, and both SDKs share six terminal outcomes: `succeeded`, `failed`, `paused`, `aborted`, `timeout`, and `budget_exceeded`. Checkpoint restore compares the post-tool fingerprint and refuses to overwrite later user or concurrent edits.

Trace events are recursively sanitized before persistence or observer delivery. Secret fields, sensitive URL values, and secret values inside commands do not enter RunState; body-like content keeps only a length marker, while ordinary test commands remain reviewable. This defense does not replace operating-system access controls or a business-data retention policy.

## Evaluation

Use deterministic tests for parsers, policies, state transitions, and protocol behavior. Use golden examples for cross-language parity. Live-provider tests are opt-in because they have cost, network, privacy, and availability implications.

Record the model, provider, framework version, platform, dataset, evaluator, and timestamp so a result can be reproduced. Never mix simulated success with live certification.

### Evidence-driven scenarios

schemaVersion 1 remains available for simple text compatibility checks. Use schemaVersion 2 when tool trajectory, test commands, files, diffs, and runtime state must be proven. Every version 2 scenario requires an outcome grader and may contain up to 20 graders.

```yaml
schemaVersion: 2
scenarios:
  - id: repair-discount
    input: Reproduce and repair the discount calculation defect
    repetitions: 3
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
        maxToolFailures: 1
      - type: command
        command: node
        args: ["--test"]
      - type: file
        path: src/discount.ts
        contains: ["Math.min"]
      - type: diff
        requiredPaths: ["src/discount.ts"]
        allowedPaths: ["src/discount.ts"]
        preserveExisting: true
      - type: state
        maxTurns: 12
        maxSecurityFindings: 0
      - type: response
        contains: ["src/discount.ts", "tests"]
```

The command grader uses a command plus argument array without shell concatenation. File and diff graders are workspace-bound. Evaluation captures protected-file and dirty-worktree baselines before execution and preserves existing user changes by default. An initial failing test may be expected reproduction evidence: it counts as a tool failure but must not be reported as a security vulnerability.

Run deterministic real-defect coverage with:

```bash
npm run build
npm run test:coding-evals
```

The [Coding Agent module](../../modules/build-coding-agents/README.en.md) and [real-defect examples](../../../examples/coding-evals/README.en.md) cover the complete reproduce, repair, test, and diff-review procedure. Live-model runs are supplemental and require explicit cost, privacy, and data-egress authorization.

## Release-candidate acceptance

Follow the [RC acceptance guide](../../release/RC-ACCEPTANCE.en.md) for P01-P20. P01-P19 require both the automated suite and exact test-title evidence anchors. P20 requires real Windows and Linux TTY records bound to the same version and commit. A current live-provider recheck and target-platform CI are independent gates and cannot be inferred from the automated matrix.
