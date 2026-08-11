# Coding Agent Guide

## When to use it

Use this workflow when a task must inspect a project, reproduce a failing test, modify a small amount of code, and provide reviewable evidence. Plain questions, fixed data lookups, and business tasks without file changes do not need the coding workflow.

## Minimal configuration

```yaml
schemaVersion: 2
name: safe-coder
provider:
  id: deepseek
  model: deepseek-chat
  apiKeyEnv: DEEPSEEK_API_KEY
agents:
  main:
    systemPrompt: |
      Reproduce the failure and locate its cause first. Make only the smallest required change.
      Run the target and full regression tests, then report files, diffs, and test results.
    tools:
      - id: read
      - id: edit
      - id: write
      - id: git_status
      - id: git_diff
permissions:
  mode: ask
  workspaceOnly: true
  network: ask
runtime:
  maxTurns: 20
  maxToolCalls: 30
  maxToolFailures: 3
quality:
  profile: standard
```

On Windows, constrained modes do not execute test commands through the host shell. Run tests manually, or select the open host-process, workspace, and network boundaries only after accepting them explicitly. Linux can use the built-in shell when its isolation prerequisites are satisfied.

## TypeScript SDK: establish the engineering loop

```ts
import {
  buildRepositoryMap,
  createEngineeringKernelDefinition,
  createEngineeringTaskPlan,
  inspectCodingRepository,
  selectCodingEnvironment,
} from "coremind-ai";

const inspection = await inspectCodingRepository(process.cwd());
// Present ambiguous suggestions to the user before passing their explicit choice.
const selection = await selectCodingEnvironment(inspection, {
  language: "typescript",
  packageManager: "npm",
  testCommand: "npm test",
});
const repoMap = buildRepositoryMap(inspection, selection);
const plan = createEngineeringTaskPlan({
  task: "Repair order discount calculation",
  acceptanceCriteria: ["Target test passes", "Regression passes", "Diff stays in scope"],
  selection,
});
const kernel = createEngineeringKernelDefinition({ selection });
```

Pass `kernel.loop` to the shared Runtime loop configuration. `repoMap` and `plan` are coding-domain inputs and do not redefine the generic terminal state. After changes, use `EngineeringEvidenceLedger` to bind checkpoints, diffs, and actual exit codes. The Python SDK reaches the same Runtime through the Worker/Protocol and does not create a Python-specific loop.

## schemaVersion 2 evaluation

```yaml
schemaVersion: 2
scenarios:
  - id: repair-tax
    input: Reproduce and repair the tax calculation defect
    graders:
      - { id: outcome, type: outcome, status: succeeded }
      - type: trajectory
        sequence:
          - { tool: bash, result: failed }
          - { tool: read, result: succeeded }
          - { tool: edit, result: succeeded }
          - { tool: bash, result: succeeded }
      - type: command
        command: python
        args: ["-m", "unittest", "discover", "-s", "tests"]
      - type: diff
        requiredPaths: ["src/pricing.py"]
        allowedPaths: ["src/pricing.py"]
        preserveExisting: true
      - type: state
        maxSecurityFindings: 0
      - type: response
        contains: ["tests", "src/pricing.py"]
```

## Verification

1. Preserve `git status --short` and fingerprints for protected files.
2. Inspect detection suggestions and explicitly choose the language, package manager, and test command when ambiguous.
3. Run the defect test and prove that it fails before the repair.
4. Run `coremind check coremind.yaml --profile strict`.
5. Run `coremind eval coremind.yaml --suite evals/scenarios.yaml --json`.
6. Match the plan, actual tools, checkpoints, target test, regression test, `git diff`, trace, and terminal outcome.
7. Run `npm run test:coding-evals` and require all TypeScript/Python single-file and cross-file gates to pass.
8. Repeat the run and record the pass rate. Live-model evidence supplements deterministic tests and never replaces them.

Copy the [real-defect evaluation examples](../../../examples/coding-evals/README.en.md) when starting.
