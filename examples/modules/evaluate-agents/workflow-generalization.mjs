import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseAndValidate } from "coremind-config";
import { LoopRunner } from "coremind-runtime";
import { Orchestrator } from "../../../packages/coremind-runtime/dist/orchestrator.js";

// 真实配置校验、步骤编排和 Loop 状态机共用无网络的回显 Agent。
const worker = "echo";
const branch = (label) => [action("call", label, "branch", label)];
const output = (value) => ({ outputs: { result: value } });
const reject = (code = "invalid_config") => ({ code });
const invalidValues = [null, false, 17, { value: "text" }];

function action(type, input, saveAs = "result", id = "action") {
  return { type, id, agent: worker, input, saveAs };
}

function conditional(condition) {
  return { type: "if", id: "gate", condition, then: branch("yes"), else: branch("no") };
}

function selector(cases, fallback = branch("other")) {
  return { type: "switch", id: "select", on: "prompt", cases, default: fallback };
}

function workflowCases(type, value, variant, add) {
  let base;
  const run = (category, name, steps, expected, prompt = value, limits = {}) =>
    add(category, name, { workflow: steps, prompt, limits }, expected);
  const same = (category, name, step, expected) => run(category, name, [step], expected);
  const branchOutput = (label) => ({ outputs: { branch: label } });
  const limit = (step, limits) =>
    run("constraint", "budget", [step], reject("step_limit"), value, limits);

  if (type === "prompt" || type === "call") {
    base = action(type, "{{prompt}}");
    same("normal", "echo", base, output(value));
    const literal = ["", " ", "{{unbound}}", "$&\n尾行"][variant];
    same("boundary", "literal", action(type, literal), output(literal));
    run(
      "composition",
      "handoff",
      [base, action(type, "{{result.text}}/{{result}}", "next", "next")],
      { outputs: { result: value, next: `${value}/${value}` } },
    );
    same("extra", "annotation", { ...base, annotation: { value } }, output(value));
    // 任意模型回显均不是单独一项状态值，包含操作符和换行的文本也一样。
    same(
      "adversarial",
      "retry-data",
      { ...base, retry: { max: 0, if: "{{text}} == RETRY" } },
      output(value),
    );
    const retryMax = variant % 2;
    run(
      "constraint",
      "retry-budget",
      [{ ...base, retry: { max: retryMax, if: "true" } }],
      reject(retryMax ? "retry_limit" : "retry_exhausted"),
      value,
      { maxRetries: 0 },
    );
  } else if (type === "parallel") {
    const children = Array.from({ length: variant + 1 }, (_, i) =>
      action("call", `${i}:{{prompt}}`, `part${i}`, `p${i}`),
    );
    base = { type, id: "group", saveAs: "result", steps: children };
    const parts = Object.fromEntries(children.map((c, i) => [c.saveAs, `${i}:${value}`]));
    const expected = { outputs: { ...parts, result: Object.values(parts).join("\n") } };
    same("normal", "declaration-order", base, expected);
    const text = ["", "\n", " ", "尾行\n"][variant];
    same(
      "boundary",
      "empty-output",
      { ...base, steps: [action("call", text, "part"), action("prompt", "end", "last", "end")] },
      { outputs: { part: text, last: "end", result: text.length ? `${text}\nend` : "end" } },
    );
    const nested = { type, id: "outer", saveAs: "outer", steps: [base] };
    same("composition", "nested", nested, {
      outputs: { ...expected.outputs, outer: expected.outputs.result },
    });
    same("extra", "annotation", { ...base, annotation: value }, expected);
    const literal = ["{{unset}}", "false", "==", "a\nb contains c"][variant];
    same(
      "adversarial",
      "literal",
      { ...base, steps: [action("prompt", literal)] },
      output(literal),
    );
    limit(base, { maxSteps: variant + 1 });
  } else if (type === "if") {
    base = conditional("{{prompt}} == PASS");
    const operand = ["PASS", "pass", "PASS ", " 未完成"][variant];
    run(
      "normal",
      "equality",
      [base],
      branchOutput(operand.trim() === "PASS" ? "yes" : "no"),
      operand,
    );
    const literal = ["", " ", "false", "true"][variant];
    same(
      "boundary",
      "truth",
      conditional(literal),
      branchOutput(literal === "true" ? "yes" : "no"),
    );
    const prior = action("call", "{{prompt}}", "record", "record");
    run("composition", "saved-output", [prior, conditional("{{record.text}} == {{prompt}}")], {
      outputs: { record: value, branch: "yes" },
    });
    same("extra", "annotation", { ...conditional("true"), annotation: value }, branchOutput("yes"));
    same("adversarial", "equality-data", base, branchOutput("no"));
    limit(conditional("true"), { maxDepth: 0 });
  } else {
    base = selector({ hit: branch("hit") });
    const haystack = ["hit", "xxhitxx", "MISS", "HIT"][variant];
    run(
      "normal",
      "substring",
      [base],
      branchOutput(haystack.includes("hit") ? "hit" : "other"),
      haystack,
    );
    const empty = selector({});
    if (variant % 2 === 0) delete empty.default;
    same("boundary", "empty-cases", empty, empty.default ? branchOutput("other") : { outputs: {} });
    const nested = { ...base, on: "saved.text" };
    run(
      "composition",
      "saved-output",
      [action("prompt", "hit/{{prompt}}", "saved", "record"), nested],
      { outputs: { saved: `hit/${value}`, branch: "hit" } },
    );
    same("extra", "annotation", { ...base, annotation: value }, branchOutput("other"));
    const needle = ["==", "\n", "{{token}}", "$&"][variant];
    run(
      "adversarial",
      "literal-key",
      [selector({ [needle]: branch("literal") })],
      branchOutput("literal"),
      `prefix${needle}${value}`,
    );
    limit(base, { maxSteps: 1 });
  }

  const required = {
    prompt: "input",
    call: "input",
    parallel: "steps",
    if: "then",
    switch: "cases",
  }[type];
  const absent = { ...base };
  delete absent[["id", "type", required, required][variant]];
  same("missing", "required", absent, reject());
  same("wrong-type", "invalid-field", { ...base, [required]: invalidValues[variant] }, reject());
  // 约束覆盖非法标识、嵌套/顺序重名与不支持的判别值。
  if (variant === 0) same("constraint", "invalid-id", { ...base, id: "" }, reject());
  if (variant === 1) run("constraint", "duplicate-id", [base, { ...base }], reject());
  if (variant === 2) same("constraint", "unsupported-kind", { ...base, type: "unknown" }, reject());
  if (variant === 3)
    same(
      "constraint",
      "nested-duplicate",
      { type: "parallel", id: base.id, steps: [base] },
      reject(),
    );
}

function loopCases(value, variant, add) {
  const step = (input) => ({ agent: worker, input });
  const verify = { ...step("{{candidate.text}}"), passIf: "{{text}} == PASS" };
  const base = { execute: step("{{prompt}}"), verify, repair: step("PASS"), onFailure: "fail" };
  const state = (phase, candidate, repairs = 0, iterations = 1, code = null) => ({
    phase,
    candidate,
    repairs,
    iterations,
    code,
  });
  const success = (text) => state("succeeded", text);
  const fail = (text) => state("failed", text, 0, 1, "verification_failed");
  const run = (category, name, loop, expected, prompt = value) =>
    add(category, name, { loop, prompt }, expected);
  const operand = ["PASS", " pass ", "NO", " PASS "][variant];
  run(
    "normal",
    "exact-verdict",
    base,
    operand.trim() === "PASS" ? success(operand) : fail(operand),
    operand,
  );
  const limit = variant % 2 ? "pause" : "fail";
  run(
    "boundary",
    "zero-repairs",
    { ...base, maxRepairs: 0, onExhausted: limit },
    state(
      limit === "fail" ? "failed" : "paused",
      value,
      0,
      1,
      limit === "fail" ? "loop_exhausted" : "loop_paused",
    ),
  );
  run(
    "composition",
    "plan-repair",
    {
      ...base,
      planning: step("{{prompt}}"),
      execute: step("{{plan.text}}"),
      onFailure: "repair",
      verify: { ...verify, input: "{{candidate}}" },
    },
    state("succeeded", "PASS", 1, 2),
  );
  run("extra", "annotation", { ...base, annotation: value }, success("PASS"), "PASS");
  run("adversarial", "verdict-data", base, fail(value));
  const hostAccept = variant % 2 === 0;
  add(
    "composition",
    "host-decision",
    { loop: { ...base, verify: { mode: "host" } }, prompt: value, hostAccept },
    hostAccept ? success(value) : fail(value),
  );
  const absent = { ...base };
  if (variant === 3) absent.verify = step("{{candidate}}");
  else delete absent[["execute", "verify", "repair"][variant]];
  run("missing", "required", absent, reject());
  run(
    "wrong-type",
    "invalid-limit",
    { ...base, maxIterations: [null, false, "1", {}][variant] },
    reject(),
  );
  const constraint = [
    { maxIterations: 101 },
    { maxRepairs: -1 },
    { execute: { agent: "missing", input: "execute" } },
    { verify: { mode: "host", timeoutMs: 0 } },
  ][variant];
  run("constraint", "out-of-range", { ...base, ...constraint }, reject());
}

function echoDriver() {
  const messages = [];
  return {
    messages: () => messages,
    async prompt(text) {
      messages.push({ role: "assistant", content: [{ type: "text", text }] });
    },
    async waitForIdle() {},
    abort() {},
  };
}

async function execute(input) {
  const { config } = parseAndValidate({
    schemaVersion: 2,
    name: "workflow-evaluation",
    agents: { [worker]: {} },
    ...(input.workflow ? { workflow: input.workflow } : { loop: input.loop }),
  });
  if (config.workflow) {
    const orchestrator = new Orchestrator(config.workflow, {
      ...input.limits,
      initialPrompt: input.prompt,
      createAgent: (name) => (Object.hasOwn(config.agents, name) ? echoDriver() : undefined),
      events() {},
    });
    const outputs = await orchestrator.run();
    return { outputs: Object.fromEntries([...outputs].map(([key, item]) => [key, item.text])) };
  }
  const runner = new LoopRunner({
    runId: "eval",
    configFingerprint: "evaluation",
    initialPrompt: input.prompt,
    loop: config.loop,
    executeStep: async ({ input: text }) => text,
    verifyHost: async () => ({
      decision: input.hostAccept ? "accept" : "reject",
      feedback: "host",
    }),
    emit() {},
    async persistSnapshot() {},
  });
  const { snapshot, error, outputs } = await runner.run();
  return {
    phase: snapshot.phase,
    candidate: outputs.get("candidate")?.text,
    repairs: snapshot.repairCount,
    iterations: snapshot.iteration,
    code: error?.code ?? null,
  };
}

export async function runWorkflowCases({ seed }) {
  const cases = [];
  for (const type of ["prompt", "call", "parallel", "if", "switch", "loop"]) {
    for (let variant = 0; variant < 4; variant++) {
      const suffix = createHash("sha256")
        .update(`${seed}/${type}/${variant}`)
        .digest("hex")
        .slice(0, 8);
      const value = [
        `记录-${suffix}`,
        `FAIL\n原因-${suffix}`,
        `FAIL\r\n${suffix} contains 分隔`,
        `状态-${suffix} == 原文`,
      ][variant];
      const add = (category, family, input, expected) =>
        cases.push({
          id: `workflow/${type}/${family}/${variant}`,
          type: type === "loop" ? "loop" : `workflow.${type}`,
          category,
          input,
          expected,
        });
      if (type === "loop") loopCases(value, variant, add);
      else workflowCases(type, value, variant, add);
    }
  }
  for (const row of cases) {
    const start = performance.now();
    try {
      row.actual = await execute(row.input);
    } catch (error) {
      row.actual = { code: error?.code ?? error?.name ?? "unknown" };
      row.evidence = String(error?.message ?? error);
    }
    row.durationMs = Math.round((performance.now() - start) * 1000) / 1000;
    row.passed = isDeepStrictEqual(row.actual, row.expected);
  }
  return cases;
}
