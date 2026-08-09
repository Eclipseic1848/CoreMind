# Testing, Evaluation, and Quality Gates Guide

## When to use it

Separate runtime outcome, metrics, business evaluation, and release readiness while preventing failures from masquerading as passes.

## Minimal text example (schemaVersion 1 compatibility)

```text
schemaVersion: 1
scenarios:
  - id: paid-order
    input: 查询订单 A-100
    expected:
      contains:
        - 已支付
      notContains:
        - TODO
```

## Multi-evidence example (recommended schemaVersion 2)

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
        maxApprovals: 0
        maxSecurityFindings: 0
      - type: response
        contains: ["src/discount.ts", "tests"]
```

The seven grader types validate outcome, tool trajectory, commands, files, Git diff, runtime state, and final response. Evaluation captures file and dirty-worktree baselines first. Commands do not use shell concatenation, and paths cannot escape the workspace.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/evaluate-agents/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. For code changes, also inspect target tests, complete regression, the allowed-file list, and fingerprints of pre-existing dirty files.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not misclassify an expected initial reproduction failure as a security vulnerability. Keep security findings separate from non-reversible-effect warnings.
- Do not let automated review impersonate business-owner or release-owner sign-off.
