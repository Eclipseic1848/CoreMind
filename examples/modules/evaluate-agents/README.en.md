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

## Offline regression for the five optional capabilities

Run from the repository root after installing its dependencies. Use a Python environment with all three requirements files below. Set `COREMIND_ONTOLOGY_PYTHON` when selecting a specific interpreter.

```sh
npm run build
python -m pip install -r examples/modules/manage-knowledge/requirements.txt -r examples/modules/manage-memory/requirements.txt -r examples/modules/manage-ontology/requirements.txt
node examples/modules/evaluate-agents/capability-regression.mjs --output .scratch/capability-regression.json
```

The report contains observations and pass status for each capability. Knowledge uses a fixed held-out set, FTS5 and replayed answers. Memory runs the MCP service and Hindsight adapter against fixed responses and uses a deterministic consumer. The Skill comparison runs both arms through the Runtime with a loopback model fixture. Tools and ontology check actual loopback calls, authorization and business action receipts. A failed evaluation yields a nonzero exit status while keeping results from the other evaluations. See the [evaluation SOP](../../../docs/modules/evaluate-agents/SOP.en.md#regression-for-the-five-optional-capabilities) for scoring.

Return to the [English guide](../../../docs/modules/evaluate-agents/GUIDE.en.md).
