import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  CoreMindRuntime,
  loadConfigFile,
  loadEvaluationSuite,
  parseAndValidate,
  runEvaluationSuite,
} from "coremind-ai";
import { parseContractReview } from "../../golden/contract-review-workflow/src/result.ts";
import {
  orderCases,
  researchCases,
  runSalesWorker,
  salesCases,
  specimens,
  stageTool,
} from "./business-generalization.mjs";
import { publicProvider } from "./public-provider.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const gold = path.join(root, "examples/golden");
const types = [
  "faq-order-assistant",
  "contract-review-workflow",
  "bounded-research-agent",
  "verified-repair-loop",
  "python-data-analysis",
];
const [order, contract, research, loop, sales] = types;
const schema =
  "输出单个 JSON 对象，仅含 riskLevel（low/medium/high）、summary（字符串）、requiresHumanReview（布尔），不使用 Markdown。";

function contractVariants(seed) {
  const clauses = [
    ["未约定责任上限。", "high"],
    ["本合同约定责任无限。", "high"],
    ["责任上限已定，付款日期待确认。", "medium"],
    ["责任上限已定，但验收时限空缺。", "medium"],
    ["仅变更通讯地址，责任和金额不发生变化。", "low"],
    ["双方仅互换公开资料，不产生任何费用和赔偿义务。", "low"],
    ["附件写明责任上限为合同金额，验收时限与付款日期均完整。", "low"],
    ["责任上限已定，付款日期待确认，并仅变更通讯地址。", "medium"],
  ];
  return specimens(contract, seed, (mode, group, n) => {
    const [clause, level] = clauses[mode];
    const prompt =
      ["审核以下条款", "提取条款并分级", "请办理复核", "对以下虚构合约作审查"][group] +
      "。内部样例口径：缺少责任上限或责任无限为 high；付款或验收时限待定为 medium；其余为 low。有多个风险时取最高。medium/high 需人工复核。\n" +
      "合成编号 C-" +
      n +
      "，合同条款：" +
      clause;
    return {
      category: [
        "uncapped",
        "unlimited",
        "missing-date",
        "missing-acceptance",
        "address-only",
        "public-information",
        "complete",
        "combined",
      ][mode],
      input: { prompt },
      expected: { level, review: level !== "low" },
    };
  });
}

function loopVariants(seed) {
  return specimens(loop, seed, (mode, group, n) => {
    const a = 5 + (n % 30);
    const values = [a, -((n % 9) + 1), group, a, a * 2];
    const descending = mode % 2 === 1;
    const unique = group % 2 === 0;
    const sorted = [...(unique ? new Set(values) : values)].sort((x, y) =>
      descending ? y - x : x - y,
    );
    const candidate = [values.join(","), String(values[0]), values.join(" "), sorted.join(",")][
      mode >> 1
    ];
    const prompt =
      "输入数字为 " +
      JSON.stringify(values) +
      "。验收规则：数值" +
      (descending ? "降" : "升") +
      "序，" +
      (unique ? "去除重复值" : "保留重复值") +
      "，用英文逗号连接，不要空格。初始候选：" +
      candidate;
    return {
      category: [
        "unsorted-asc",
        "unsorted-desc",
        "partial-asc",
        "partial-desc",
        "delimiter-asc",
        "delimiter-desc",
        "valid-asc",
        "valid-desc",
      ][mode],
      input: { prompt, values, candidate },
      expected: { output: sorted.join(","), repair: candidate !== sorted.join(",") },
    };
  });
}

async function historyCases() {
  const cases = [];
  for (const type of types) {
    const project = path.join(gold, type);
    const { scenarios } = await loadEvaluationSuite(path.join(project, "evals/scenarios.yaml"));
    for (const scenario of scenarios) {
      const input = { prompt: scenario.input };
      let expected;
      if (type === order) {
        input.orders = JSON.parse(await readFile(path.join(project, "data/orders.json"), "utf8"));
        const id = scenario.input.match(/A-\d+/)?.[0];
        expected = input.orders.find((row) => row.id === id) ?? { missing: id };
      } else if (type === research) {
        input.source = JSON.parse(await readFile(path.join(project, "data/evidence.json"), "utf8"));
        expected = scenario.expected.contains.filter((s) => /^S\d+$/.test(s));
      } else if (type === sales) {
        input.csv = await readFile(path.join(project, "data/sales.csv"), "utf8");
        expected = { summary: { rows: 3, total: 300, byRegion: { 华东: 220, 华南: 80 } } };
      } else if (type === contract) expected = { level: "high", review: true };
      else expected = { output: "candidate-fixed" };
      cases.push({
        id: `history-${scenario.id}`,
        type,
        category: "historical",
        input,
        expected,
        scenario,
      });
    }
  }
  return cases;
}

export function effectivePublicBusinessConfig(raw, c) {
  raw.provider = { ...publicProvider, thinkingFormat: "qwen", maxTokens: 512, contextWindow: 8192 };
  for (const agent of Object.values(raw.agents)) {
    agent.options = { ...agent.options, temperature: 0, maxTokens: 512, thinkingLevel: "off" };
  }
  raw.runtime = {
    ...raw.runtime,
    maxRetries: 0,
    maxTokens: 12000,
    runTimeoutMs: 120000,
    stepTimeoutMs: 45000,
  };
  if (
    !c.scenario &&
    c.type === contract &&
    !raw.agents.formatter.systemPrompt.includes("requiresHumanReview")
  )
    raw.agents.formatter.systemPrompt += schema;
  if (!c.scenario && c.type === loop) {
    raw.agents.executor.systemPrompt = "只原样提交输入的初始候选。独立验证器会按规则检查。";
    raw.agents.verifier.systemPrompt =
      "重新计算验收规则并与候选逐字比较。完全一致只输出 PASS，否则只输出 FAIL。";
    raw.agents.repairer.systemPrompt = "根据原始输入和验收规则重算，输出修正后的候选，不写解释。";
    raw.loop.verify.input = "原任务：{{prompt}}\n本次候选：{{candidate.text}}";
    raw.loop.repair.input =
      "原任务：{{prompt}}\n本次候选：{{candidate.text}}\n验证反馈：{{verification.text}}";
    raw.loop.maxRepairs = 1;
    raw.loop.maxIterations = 2;
  }
  return parseAndValidate(raw).config;
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function inspectRun(run) {
  const messages = Array.from(run.messages.values()).flat();
  const calls = messages
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      tool: m.toolName,
      error: m.isError,
      text:
        typeof m.content === "string"
          ? m.content
          : (m.content ?? []).map((v) => v.text ?? "").join(""),
    }));
  const context = run.metrics.context ?? {};
  return {
    status: run.outcome.status,
    reason: run.outcome.finishReason,
    errorCode: run.outcome.error?.code,
    runId: run.runId,
    transcript: run.transcript,
    calls,
    toolCalls: run.metrics.toolCalls,
    toolFailures: run.metrics.toolFailures,
    turns: run.metrics.turns,
    tokens: run.metrics.tokens,
    inputTokens: context.inputTokens,
    outputTokens: context.outputTokens,
    runtimeModel: context.lastBudget?.modelId,
    assistantModels: [
      ...new Set(messages.filter((m) => m.role === "assistant" && m.model).map((m) => m.model)),
    ],
    steps: run.trace.filter((t) => t.event.type === "step_start").map((t) => t.event.stepId),
    verification: run.outputs.get("verification")?.text,
  };
}

function grade(c, a) {
  const e = c.expected,
    t = a.transcript ?? "";
  if (c.type === order) {
    const tool = a.calls.filter((v) => v.tool === "lookup_order").at(-1);
    const data = e.missing
      ? Boolean(tool?.error && tool.text.includes(e.missing))
      : isDeepStrictEqual(json(tool?.text), e);
    const money = [
      ...t.replaceAll(",", "").matchAll(/(?:^|[^\d.-])(\d+(?:\.\d+)?)(?=$|[^\d.])/g),
    ].map((m) => Number(m[1]));
    const label = {
      paid: /已支付|已付款|paid/i,
      pending: /待支付|未支付|待付款|pending/i,
      refunded: /已退款|退款成功|refunded/i,
    };
    const answer = e.missing
      ? t.includes(e.missing) && /未找到|不存在|查无|未查询到|未查到|没有找到/.test(t)
      : t.includes(e.id) && label[e.status].test(t) && money.includes(e.amount);
    return { tool: data, answer: Boolean(answer) };
  }
  if (c.type === research) {
    const calls = a.calls.filter((v) => v.tool === "search_knowledge" && !v.error);
    const found = new Set(calls.flatMap((v) => (json(v.text) ?? []).map((row) => row.id)));
    const citations = [...new Set(t.match(/\bS\d+\b/g) ?? [])].sort();
    const facts = c.input.source.filter((row) => e.includes(row.id));
    return {
      tool: calls.length > 0 && isDeepStrictEqual([...found].sort(), [...e].sort()),
      ...(!c.scenario && {
        facts:
          facts.every((row) => t.includes(row.finding)) &&
          c.input.source
            .filter((row) => !e.includes(row.id))
            .every((row) => !t.includes(row.finding)),
      }),
      answer:
        isDeepStrictEqual(citations, [...e].sort()) &&
        (e.length > 0 || /没有|无法|未|缺乏|不足|为空|无相关/.test(t)),
    };
  }
  if (c.type === contract) {
    let result;
    try {
      result = parseContractReview(t);
    } catch {
      /* 严格按公开宿主接口消费回复。 */
    }
    return {
      stages: isDeepStrictEqual(a.steps, ["extract", "review", "format"]),
      schema: Boolean(result),
      verdict: result?.riskLevel === e.level && result?.requiresHumanReview === e.review,
    };
  }
  if (c.type === loop)
    return {
      verified: a.hostChecks?.length > 0 || a.steps.some((s) => s.startsWith("loop-verify:")),
      candidate: t.trim() === e.output,
      repairs:
        e.repair === undefined || a.steps.some((s) => s.startsWith("loop-repair:")) === e.repair,
    };
  if (e.rejected)
    return {
      rejected:
        a.status !== "succeeded" &&
        a.toolFailures > 0 &&
        a.calls.some(
          (v) =>
            v.tool === "analyze_sales" &&
            v.error &&
            (c.category === "missing-column"
              ? v.text === "'amount'"
              : v.text.includes("could not convert string to float")),
        ),
      noArtifact: a.artifact === null,
    };
  return {
    called: a.calls.some((v) => v.tool === "analyze_sales" && !v.error),
    artifact: isDeepStrictEqual(a.artifact, e.summary),
    transcript: isDeepStrictEqual(json(t), e.summary),
  };
}

export function gradePublicBusinessReceipt(row) {
  if (!row.actual?.calls)
    return { checks: { completed: false }, businessPassed: false, passed: false };
  const checks = grade(row, row.actual);
  const businessPassed = Boolean(
    (row.expected.rejected || row.actual.status === "succeeded") &&
      Object.values(checks).every(Boolean),
  );
  return {
    checks,
    businessPassed,
    passed: businessPassed && (!row.scenario || row.yaml?.passed === true),
  };
}

async function runCase(c, cwd, config) {
  const project = path.join(gold, c.type);
  if (c.type === order) await stageTool(project, cwd, "orders.json", c.input.orders);
  if (c.type === research) await stageTool(project, cwd, "evidence.json", c.input.source);
  let run, artifact;
  const checks = [];
  const replies = [];
  async function perform() {
    if (c.type === sales) {
      const [record] = await runSalesWorker(config, [c.input], cwd);
      if (!record.run) throw new Error("Python Worker 没有返回 Run");
      artifact = record.artifact;
      run = {
        ...record.run,
        messages: new Map(Object.entries(record.run.messages)),
        outputs: new Map(Object.entries(record.run.outputs)),
      };
    } else {
      const agent = await CoreMindRuntime.create({
        config,
        configDir: cwd,
        cwd,
        initialPrompt: c.input.prompt,
        approveProjectCode: () => true,
        approveTool: async (r) =>
          ["lookup_order", "search_knowledge"].includes(r.tool) ? "allow" : "deny",
        ...(config.loop?.verify.mode === "host" && {
          onVerification: (request) => {
            const accepted = request.candidate.trim() === c.expected.output;
            checks.push({ candidate: request.candidate, accepted });
            replies.push(
              agent.acceptControl({
                schemaVersion: 1,
                controlId: `verdict-${request.requestId}`,
                runId: request.runId,
                requestId: request.requestId,
                candidateSha256: request.candidateSha256,
                type: "verification",
                decision: accepted ? "accept" : "reject",
                feedback: accepted ? "" : "候选没有满足原任务的排序和输出格式要求",
              }),
            );
          },
        }),
      });
      run = await agent.run();
      await Promise.all(replies);
    }
    return run;
  }
  let yaml;
  if (c.scenario) {
    const evaluated = await runEvaluationSuite({
      config,
      configDir: cwd,
      cwd,
      suite: { schemaVersion: 1, scenarios: [c.scenario] },
      runtimeFactory: () => ({ run: perform }),
    });
    const attempt = evaluated.attempts[0];
    yaml = { passed: attempt.passed, graders: attempt.graderResults };
  } else await perform();
  if (!run) throw new Error("未获得 Runtime 回执");
  const actual = {
    ...inspectRun(run),
    ...(c.type === sales && { artifact }),
    ...(checks.length && { hostChecks: checks }),
  };
  return { actual, yaml, ...gradePublicBusinessReceipt({ ...c, actual, yaml }) };
}

async function saveJson(file, value) {
  const pending = `${file}.tmp-${process.pid}`;
  await writeFile(pending, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(pending, file);
}

// 同时核对实跑的 SDK、Worker、工具、判分器及依赖锁，避免代码变化后复用旧分数。
async function executionFingerprint() {
  const files = [
    "package-lock.json",
    ...[
      "business-public.mjs",
      "business-generalization.mjs",
      "business-sales-worker.py",
      "public-provider.mjs",
    ].map((f) => `examples/modules/evaluate-agents/${f}`),
    "examples/golden/faq-order-assistant/src/order-tool.ts",
    "examples/golden/bounded-research-agent/src/search-tool.ts",
    "examples/golden/contract-review-workflow/src/result.ts",
    "examples/golden/python-data-analysis/src/main.py",
  ];
  const dirs = [
    "coremind",
    "coremind-config",
    "coremind-protocol",
    "coremind-runtime",
    "coremind-tools",
    "coremind-worker",
  ].map((p) => `packages/${p}/dist`);
  for (const dir of [...dirs, "python/src/coremind"]) {
    const extension = dir.startsWith("python/") ? /\.py$/ : /\.m?js$/;
    const matches = await readdir(path.join(root, dir), { recursive: true });
    files.push(
      ...matches
        .filter((f) => extension.test(f))
        .map((f) => path.join(dir, f).replaceAll("\\", "/")),
    );
  }
  const digest = createHash("sha256").update(process.version);
  for (const file of files.sort())
    digest
      .update(file)
      .update("\0")
      .update(await readFile(path.join(root, file)))
      .update("\0");
  return digest.digest("hex");
}

export async function runPublicBusiness({
  seed = 20261126,
  output,
  only,
  configDir = gold,
  resume = false,
  concurrency = 4,
  hostLoop = false,
}) {
  if (
    !Number.isSafeInteger(seed) ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  )
    throw new Error("种子须为整数，并行数须介于 1 至 4");
  if (!process.env[publicProvider.apiKeyEnv]) throw new Error("缺少公网模型所需的凭据环境变量");
  const dir = path.resolve(output);
  const folder = path.join(dir, "receipts");
  await mkdir(folder, { recursive: true });
  if (!resume && (await readdir(folder)).length)
    throw new Error("输出目录已有公网回执，请指定新的目录，或显式使用 --resume");
  const executionSha256 = await executionFingerprint();
  const scratch = path.join(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  const all = await publicBusinessCases(seed);
  const selected = only?.split(",");
  const cases = selected
    ? all.filter((c) => [c.id, c.category, c.type].some((value) => selected.includes(value)))
    : all;
  if (!cases.length) throw new Error("没有匹配的用例");
  const configs = new Map(
    await Promise.all(
      types.map(async (type) => [
        type,
        await loadConfigFile(path.join(configDir, type, "coremind.yaml")),
      ]),
    ),
  );
  const rows = [];
  let sampled = 0,
    reused = 0,
    sampledTokens = 0;
  const temp = await mkdtemp(path.join(scratch, "public-golden-"));
  let next = 0;
  async function worker() {
    while (next < cases.length) {
      const c = cases[next++];
      const file = path.join(folder, `${c.id}.json`);
      const raw = structuredClone(configs.get(c.type));
      const config = effectivePublicBusinessConfig(raw, c);
      if (hostLoop && c.type === loop && !c.scenario) {
        config.loop.verify = { mode: "host", timeoutMs: 5_000 };
      }
      const configSha256 = createHash("sha256").update(JSON.stringify(config)).digest("hex");
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([publicProvider, seed, c, configSha256, executionSha256]))
        .digest("hex");
      try {
        const prior = JSON.parse(await readFile(file, "utf8"));
        if (prior.fingerprint !== fingerprint)
          throw new Error("已有不同参数的回执，请使用新的输出目录");
        if (!resume) throw new Error("另一进程已启动相同的公网采样，请使用独立目录");
        if (
          prior.actual.status !== "execution-error" &&
          prior.actual.reason !== "provider_transient"
        ) {
          rows.push(prior);
          reused++;
          continue;
        }
        const archive = path.join(dir, "prior-attempts");
        await mkdir(archive, { recursive: true });
        await saveJson(path.join(archive, `${c.id}-${Date.now()}.json`), prior);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const start = performance.now();
      const cwd = path.join(temp, c.id);
      await mkdir(cwd);
      let measured;
      try {
        measured = await runCase(c, cwd, config);
      } catch (error) {
        measured = {
          passed: false,
          businessPassed: false,
          failure: error.name,
          actual: { status: "execution-error" },
        };
      }
      const row = {
        ...c,
        ...measured,
        provider: publicProvider.id,
        model: publicProvider.model,
        configSha256,
        executionSha256,
        fingerprint,
        durationMs: Math.round(performance.now() - start),
      };
      await saveJson(file, row);
      rows.push(row);
      sampled++;
      sampledTokens += row.actual.tokens ?? 0;
    }
  }
  try {
    const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    for (const finished of workers) if (finished.status === "rejected") throw finished.reason;
    const summary = {
      ...summarizePublicBusiness(rows),
      sampled,
      reused,
      sampledTokens,
      executionSha256,
    };
    const label =
      selected?.length > 1 ? createHash("sha256").update(only).digest("hex").slice(0, 16) : only;
    await saveJson(path.join(dir, label ? `summary-${label}.json` : "summary.json"), summary);
    return summary;
  } finally {
    if (path.dirname(temp) === scratch && path.basename(temp).startsWith("public-golden-"))
      await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function publicBusinessCases(seed) {
  const variants = [
    orderCases(seed),
    contractVariants(seed),
    researchCases(seed),
    loopVariants(seed),
    salesCases(seed),
  ];
  return [
    ...(await historyCases()),
    ...variants[0].flatMap((_, i) => variants.map((group) => group[i])),
  ];
}

export function summarizePublicBusiness(rows) {
  const count = (group) => ({ total: group.length, success: group.filter((r) => r.passed).length });
  const history = rows.filter((r) => r.scenario);
  return {
    ...count(rows),
    passed: rows.length > 0 && rows.every((r) => r.passed),
    provider: publicProvider.id,
    model: publicProvider.model,
    history: {
      ...count(history),
      yamlSuccess: history.filter((r) => r.yaml?.passed).length,
      businessSuccess: history.filter((r) => r.businessPassed).length,
    },
    variants: count(rows.filter((r) => !r.scenario)),
    types: Object.fromEntries(types.map((t) => [t, count(rows.filter((r) => r.type === t))])),
    tokens: rows.reduce((n, r) => n + (r.actual.tokens ?? 0), 0),
  };
}

async function regrade(output) {
  const dir = path.join(path.resolve(output), "receipts");
  const rows = [];
  for (const name of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
    const row = JSON.parse(await readFile(path.join(dir, name), "utf8"));
    if (row.provider !== publicProvider.id || row.model !== publicProvider.model)
      throw new Error("回执模型与指定公网快照不同");
    rows.push({ ...row, ...gradePublicBusinessReceipt(row) });
  }
  const summary = summarizePublicBusiness(rows);
  await saveJson(path.join(path.resolve(output), "regraded.json"), {
    ...summary,
    rows: rows.map(({ id, checks, passed, businessPassed }) => ({
      id,
      checks,
      passed,
      businessPassed,
    })),
  });
  return summary;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      only: { type: "string" },
      seed: { type: "string" },
      "config-dir": { type: "string" },
      resume: { type: "boolean" },
      concurrency: { type: "string" },
      regrade: { type: "boolean" },
      "host-loop": { type: "boolean" },
    },
  });
  if (!values.output) throw new Error("请使用 --output 指定回执目录");
  const summary = values.regrade
    ? await regrade(values.output)
    : await runPublicBusiness({
        seed: Number(values.seed ?? 20261126),
        output: values.output,
        only: values.only,
        configDir: values["config-dir"],
        resume: values.resume,
        concurrency: Number(values.concurrency ?? 4),
        hostLoop: values["host-loop"],
      });
  console.log(JSON.stringify(summary));
  if (!summary.passed) process.exitCode = 1;
}
