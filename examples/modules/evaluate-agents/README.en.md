# Testing, Evaluation, and Quality Gates Example

This is the smallest module example. Ask the business owner to confirm fields and rules before copying it.

```text
schemaVersion: 2
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    repetitions: 3
    graders:
      - { type: outcome, status: succeeded }
      - { type: response, contains: [已支付], notContains: [TODO] }
      - { type: state, maxToolFailures: 0, maxSecurityFindings: 0 }
```

## Verification

1. Run the tests listed in the module manifest from the repository root.
2. Run `coremind check` for configuration examples.
3. Add scenarios and run `coremind eval` for business outputs.
4. Inject one failure and confirm RunOutcome or the process exit code reports failure explicitly.
5. For code changes, use the [real-defect evaluations](../../coding-evals/README.en.md) and validate commands, files, diffs, and dirty-worktree preservation.
6. When comparing two strategies, use `defineExperiment` to freeze the version, seed, arm weights, and input fingerprint, then retain the complete trace and graders in `ExperimentRecord`.

Return to the [English guide](../../../docs/modules/evaluate-agents/GUIDE.en.md).
