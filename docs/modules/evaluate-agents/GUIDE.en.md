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

## Lightweight experiments

```ts
const experiment = defineExperiment({
  id: "context-strategy",
  version: "1",
  seed: "team-approved-seed",
  arms: [
    { id: "baseline", weight: 1 },
    { id: "candidate", weight: 1, config: { compact: true } },
  ],
});

const record = await runExperiment({
  definition: experiment,
  inputFingerprint: "sha256:fixture-a",
  environment,
  run: async (arm) => executeAndGrade(arm),
});
```

`ExperimentRecord` retains the assignment hash, arm, environment, terminal state, metrics, complete trace, and graders. Fingerprint real inputs first; never place sensitive source text in the experiment ledger.

## Paired version evaluation (repository maintainers)

Obtain the complete trusted stable-release bundle, then run `npm run candidate:bundle` on a clean, fixed candidate commit. Retain every artifact referenced by each `release-manifest.json`. A version string alone does not identify an artifact; rebuilding old source does not recreate its published package.

Hash the actual manifest bytes and freeze the common fixtures with the coordinator's own algorithm:

```sh
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync('/absolute/bundle/release-manifest.json')).digest('hex'))"
node --input-type=module -e "import {fingerprintTree} from './scripts/run-paired-evaluation.mjs'; console.log(await fingerprintTree('examples/coding-evals'))"
```

Replace the placeholders below with real absolute paths, manifest digests, and commits, then save `paired-input.json`. Use a new `outputDirectory`.

```json
{
  "schemaVersion": 1,
  "arms": [
    { "id": "baseline", "artifactRoot": "/absolute/stable-bundle", "manifestSha256": "<actual 64-character manifest SHA-256>", "commit": "<actual stable commit>" },
    { "id": "candidate", "artifactRoot": "/absolute/candidate-bundle", "manifestSha256": "<actual 64-character manifest SHA-256>", "commit": "<actual candidate commit>" }
  ],
  "fixtures": { "root": "/absolute/CoreMind/examples/coding-evals", "sha256": "<fixture digest above>" },
  "cases": ["typescript-defect", "python-defect"],
  "repetitions": 3,
  "outputDirectory": "/absolute/new-paired-report"
}
```

```sh
npm run eval:paired -- --input paired-input.json
```

The coordinator freezes the complete two-case × two-arm × three-repetition plan before execution, alternating AB/BA order. Each arm installs all eight npm tarballs together in an isolated directory and records its actual lockfile, installation-tree, and entry digests. Every cell has its own process and workspace and reuses the existing graders. Installation preparation requires a trusted Registry or cache; evaluation uses local mock services and needs no paid Provider.

`plan.json`, `results.jsonl`, and `report.json` retain the plan, individual terminal results, and aggregate report. Preparation failures, abnormal exits, malformed output, and timeouts remain in the ledger. Missing cells, duplicates, identity mismatches, or safety failures prevent qualification. Incomplete pairs and failure-placeholder zeros cannot win performance comparisons; missing metrics remain `null` / unavailable.

Import, CLI light-entry startup, Worker initialization, normal EOF, stream consumption, and cancellation are recorded separately. A new process has an empty module cache, not necessarily a cold operating-system disk cache. Warm measurements use an independent new Run in the same warmed Worker and stay separate. Stream probes disable Session persistence except for the cancellation-session check. Slow consumption acts on the real Worker output pipe and does not establish end-to-end Provider backpressure. Local SSE latency and synthetic usage do not establish real-model TTFT, cost, cache savings, or business quality. Retain inconclusive results honestly and do not generate automatic review approval.

## Verification

1. Follow the [SOP](SOP.en.md).
2. Run the [module example](../../../examples/modules/evaluate-agents/README.en.md).
3. Run `coremind check`; also run `coremind eval` for business outputs.
4. Inspect failure status, budgets, traces, approvals, and checkpoints instead of judging only fluent text.
5. For code changes, also inspect target tests, complete regression, the allowed-file list, and fingerprints of pre-existing dirty files.
6. Re-run the same frozen task set and compare success, tool failures, approvals, cost, and recovery evidence. Do not move weights or gates after observing results.

## Common mistakes

- Do not let the model invent business rules for the owner.
- Do not treat one successful run as stability evidence.
- Do not use full mode to bypass configured deny rules, audit, checkpoints, or recovery. Path-aware file tools enforce workspace policy; arbitrary shell execution has separate platform limits.
- Do not describe inherited providers as genuinely certified.
- Do not misclassify an expected initial reproduction failure as a security vulnerability. Keep security findings separate from non-reversible-effect warnings.
- Do not let automated review impersonate business-owner or release-owner sign-off.
