# Workflows and Explicit Bounded Loops Example

Use `workflow` for a fixed two-step pipeline. The following `loop` is only for an independently verified result with bounded repair:

```yaml
loop:
  execute:
    agent: coder
    input: "{{prompt}}"
  verify:
    agent: reviewer
    input: "{{candidate.text}}"
    passIf: "{{text}} == PASS"
  repair:
    agent: coder
    input: "{{verification.text}}"
  maxIterations: 3
  maxRepairs: 2
  maxRepeatedAction: 2
  onFailure: repair
  onExhausted: fail
```

See the runnable [verified repair golden example](../../golden/verified-repair-loop/README.en.md). It deliberately fails the first verification and asserts repair success, pause-resume, and exhaustion failure.

## Verification

1. Run `coremind check coremind.yaml`.
2. Use `--json-events` to inspect ordered `loop_state` events and the final `run_result`.
3. Inject denial, 503, no progress, and exhaustion; none may masquerade as success.
4. Resume the same run ID and confirm completed steps and committed effects do not replay.

Return to the [English guide](../../../docs/modules/design-workflows/GUIDE.en.md).
