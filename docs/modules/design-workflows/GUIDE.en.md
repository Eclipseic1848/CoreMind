# Workflows and Explicit Bounded Loops Guide

## Step 1: choose the mode first

- Use `workflow` when inputs pass through fixed processing steps.
- Use the basic agent loop with runtime budgets when one agent can decide its tool calls.
- Use `loop` when an independent verifier must reject a candidate and bounded repair is allowed.

Workflow `prompt`/`call` step output contains only assistant text newly produced by that step; `saveAs`, subsequent interpolation, and transcript use the same boundary. The same Session history remains available to the model. If one agent produces `A` and then `B` in consecutive steps, the second step outputs `B` without including the first step's `A`.

## Step 2: write the smallest Loop configuration

```yaml
schemaVersion: 2
name: verified-loop
agents:
  coder:
    systemPrompt: Generate or repair the candidate
  reviewer:
    systemPrompt: Verify independently and output only PASS or FAIL

loop:
  execute:
    agent: coder
    input: "Execute: {{prompt}}"
  verify:
    agent: reviewer
    input: "Verify: {{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair:
    agent: coder
    input: "Repair {{candidate.text}} using {{verification.text}}"
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair
  onExhausted: fail
```

`passIf` must be deterministic and testable. Use `onFailure: pause` when a human must decide before repair, and `onFailure: fail` when automatic repair is forbidden.

For host acceptance in `0.8.0`, replace the example's `verify` with `verify: { mode: host, timeoutMs: 30000 }`. The host then submits an `acceptControl` decision bound to the request identity and candidate hash; this mode does not use `passIf`. `accepted` only acknowledges receipt, so inspect the final Run outcome. See the [host verification example](../../../examples/host-verification/README.en.md).

## Step 3: run and observe

```powershell
coremind check coremind.yaml
coremind run coremind.yaml --prompt "repair the candidate" --json-events
```

Inspect `loop_state` order, the final `run_result`, tool traces, effect receipts, budgets, and checkpoints. Resume a paused run with the original run ID:

```powershell
coremind run coremind.yaml --resume <runId>
```

## Step 4: test at least eight counterexamples

1. First verification returns FAIL and transitions to repair.
2. Verification still fails after repair and ends as `loop_exhausted` at the limit.
3. Repeated identical candidates hit the no-progress policy.
4. A denied approval pauses without replaying the tool.
5. One injected 503 triggers only the bounded transient retry.
6. Exit at a stable boundary and resume without replaying completed steps or committed effects.
7. One `parallel` substep fails while siblings are still waiting: cancel those siblings, wait for them to settle, preserve the first error, and admit no new model calls after the Run ends.
8. One `parallel` substep pauses while siblings still await approval or have started operations: cancel and wait for the siblings to settle, preserving the original pause reason and receipts for operations already started. Cancellation is not rollback.

Also confirm that all-success `parallel` results still aggregate in declaration order regardless of completion order.

Cancellation closes pending approvals as denied. The framework stops waiting locally; the host approval callback may continue, but a late approval no longer takes effect.

Run the [verified repair golden example](../../../examples/golden/verified-repair-loop/README.en.md) for repair success, pause-resume, and exhaustion coverage.
