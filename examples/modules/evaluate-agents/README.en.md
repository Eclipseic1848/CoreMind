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

## Historical regression and task generalization

Install the workspace dependencies from the repository root. The evaluation command builds the workspace and runs all suites. A fixed seed reproduces the generated inputs and expectations. Use separate output directories when comparing revisions.

```sh
npm ci
npm run eval:generalization -- --seed 20261126 --output .scratch/generalization-eval
```

Append `--only workflow` to select one suite. The default `all` runs all six suites below.

Single-suite runs write under `only-<suite>/` inside the output directory. Use separate output directories for independent measurements.

Set `DASHSCOPE_API_KEY` and append `--public` to use the fixed DeepSeek Flash snapshot `deepseek-v4.1-flash-1017` on Alibaba Cloud DashScope. Select `--only public-knowledge` for the 40 synthetic knowledge questions alone. The report saves correct answers with citations and correct model refusals separately from answers withheld by the verifier. BGE-M3 runs locally for retrieval.

Select `--only public-business` or `--only public-coding` for the live golden business and coding suites. To run all suites, use `npm run eval:generalization -- --public --seed 20261126 --output .scratch/generalization-eval`. Live suites send synthetic cases to DashScope and use the account's API quota.

Compare model and host verification for generated repair loops. Run `node examples/modules/evaluate-agents/business-public.mjs --only verified-repair-loop --host-loop --output .scratch/host-loop` to use Runtime host verification and record each candidate and decision. Omit `--host-loop` for text verification. The original golden case keeps its existing grader. Coding variants disclose one numerical sample in the prompt and retain another for host-only checks.

| `--only` | What runs |
| --- | --- |
| `history` | Golden projects, coding defects, sales analysis, durable task tests and Node/Python examples. |
| `capabilities` | Knowledge retrieval, memory, Skills, tools, ontology, material processing and host verification. Existing Run logs are inventoried separately. |
| `durable` | Checkpoint, reopen, cancellation and replay variants through the public `TaskSession` API. |
| `workflow` | Real configuration validation, five workflow nodes and the Loop controller with a deterministic echo agent. Checks branches, retries and verification. |
| `business` | Input variants for the five Golden business examples. Model responses come from local fixtures. The sales project executes its Python tool. |
| `retrieval` | Queries `KnowledgeCatalog` using newly generated documents and queries. Requires the local retrieval model. |

The `history`, `business`, `capabilities` and `retrieval` suites use Python. The general interpreter defaults to `python` on PATH. Prepare these environments for the full run. Interpreter variables take an executable path.

| Environment variable | Purpose |
| --- | --- |
| `COREMIND_ONTOLOGY_PYTHON` | General interpreter with ontology, memory and Skill dependencies. See the installation command above. |
| `COREMIND_RETRIEVAL_PYTHON` | Retrieval interpreter with Qdrant, ONNX and tokenizer packages from `examples/knowledge-evals/zh-retrieval/requirements-retrieval.txt`. Defaults to the general interpreter. |
| `COREMIND_DOCLING_PYTHON` | Interpreter with Docling for parser tests. Defaults to the general interpreter. |
| `COREMIND_RETRIEVAL_MODEL_DIR` | Local BGE-M3 directory containing `model_quantized.onnx` and `tokenizer.json`. Follow the [knowledge example](../manage-knowledge/README.en.md) to prepare it. |

`report.json` contains suite durations, per-type pass counts, category counts and failed case IDs. Each generated suite writes its inputs, expected and observed values, and durations to `<suite>-cases.json`. Historical tests write separate logs. Capability receipts are under `capability-history/`. Exit status is zero if every selected check and coverage threshold passes, and nonzero on failure. Missing dependencies or model files yield failed checks.

### Register a durable task type

Save this example as `trim-title.mjs` in the repository root and run `node trim-title.mjs` after building. This state-only task reads the title from the initial checkpoint. Each `resume` executes a registered phase. The same synchronous JSON Schema draft-07 validates the initial and returned checkpoints.

```js
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSession } from "coremind-ai";

const definition = {
  type: "trim-title",
  version: 1,
  initialPhase: "trim",
  checkpointSchema: { type: "string", pattern: "\\S" },
  phases: {
    trim: ({ task }) => ({ phase: "trim", checkpoint: task.checkpoint.trim(), done: true }),
  },
};
const workspace = await mkdtemp(join(await realpath(tmpdir()), "coremind-trim-"));
let session;
try {
  session = await TaskSession.open({ workspace, sessionId: "demo", definitions: [definition] });
  await session.start({ taskId: "edit", type: "trim-title", checkpoint: "  Release  " });
  const result = await session.resume("edit");
  assert.equal(result.status, "completed");
  assert.equal(result.checkpoint, "Release");
} finally {
  await session?.close();
  await rm(workspace, { recursive: true, force: true });
}
```

Register a business type using `TaskSession.open({ definitions })`. Supply a stable `type`, a positive integer `version`, an initial phase, a checkpoint schema and phase functions. Register the definition in `durable-generalization.mjs`, add at least 30 distinct inputs or action sequences for the type, and run `--only durable`. Check expected status, checkpoint and rejection codes independently. For this example cover internal spaces, surrounding whitespace, whitespace-only titles, missing input, an object value and replay of a completed task. For existing persisted tasks, supply a `migrate` function when upgrading versions and test reopening.

The YAML configuration language has five built-in nodes, `prompt`, `call`, `parallel`, `if` and `switch`. Compose these for ordinary workflows. Adding syntax requires updating the recursive configuration schema, step traversal, Orchestrator dispatch and `workflow-generalization.mjs`. Write `==`, `!=` and `contains` in condition templates. Interpolated values are operands. Add Golden business scenario variants and business-specific assertions in `business-generalization.mjs`.

Return to the [English guide](../../../docs/modules/evaluate-agents/GUIDE.en.md).
