import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import {
  CoreMindRuntime,
  loadConfigFile,
  loadEvaluationSuite,
  parseAndValidate,
  runEvaluationSuite,
} from "coremind-ai";
import { createCodingEvalMockServer } from "../../coding-evals/_shared/mock-provider.mjs";
import { createGoldenMockServer } from "../../golden/_shared/mock-provider.mjs";
import { parseContractReview } from "../../golden/contract-review-workflow/src/result.ts";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const golden = path.join(root, "examples/golden");
const coding = path.join(root, "examples/coding-evals");
const salesDir = path.join(golden, "python-data-analysis");
const python = process.env.COREMIND_ONTOLOGY_PYTHON ?? "python";
const offline = {
  ...process.env,
  GOLDEN_MOCK_API_KEY: "offline",
  CODING_MOCK_API_KEY: "offline",
  PYTHONUTF8: "1",
  PYTHONDONTWRITEBYTECODE: "1",
};

async function withServer(server, operation) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await operation(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// 原模拟服务的 HTTP 请求记录给出实际工具结果，即使模型最后输出了固定文案。
function observe(server, observations) {
  server.prependListener("request", (request) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      for (const message of JSON.parse(body).messages ?? []) {
        if (message.role === "tool") {
          observations.push(
            typeof message.content === "string"
              ? message.content
              : message.content.map((item) => item.text).join(""),
          );
        }
      }
    });
  });
  return server;
}

// 注入被测系统的上游响应。期望值与判分器均在服务之外。
function textProvider(responses, prompts = []) {
  let call = 0;
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const messages = JSON.parse(body).messages;
      prompts.push(messages.findLast((message) => message.role === "user")?.content);
      const content = responses[call++] ?? "响应序列已耗尽";
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content }, null],
        [{}, "stop"],
      ]) {
        response.write(
          `data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      }
      response.end("data: [DONE]\n\n");
    });
  });
}

async function runtime(project, cwd, server, prompt, configure = () => {}) {
  const observations = [];
  return withServer(observe(server, observations), async (baseUrl) => {
    const raw = await loadConfigFile(path.join(project, "coremind.yaml"));
    raw.provider.baseUrl = baseUrl;
    configure(raw);
    const run = await CoreMindRuntime.create({
      config: parseAndValidate(raw).config,
      configDir: cwd,
      cwd,
      env: offline,
      initialPrompt: prompt,
      approveProjectCode: () => true,
      approveTool: async () => "allow",
    });
    const result = await run.run();
    return {
      status: result.outcome.status,
      transcript: result.transcript,
      reason: result.outcome.finishReason,
      runId: result.runId,
      toolCalls: result.metrics.toolCalls,
      toolFailures: result.metrics.toolFailures,
      steps: result.trace
        .filter((entry) => entry.event.type === "step_start")
        .map((entry) => entry.event.stepId),
      observations,
    };
  });
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function specimens(type, seed, make) {
  return Array.from({ length: 32 }, (_, index) => {
    const id = `${type}-${String(index + 1).padStart(2, "0")}`;
    const n = createHash("sha256")
      .update(`${String(seed)}/${id}`)
      .digest()
      .readUInt32BE();
    return { id, type, ...make(index % 8, Math.floor(index / 8), n) };
  });
}

const statuses = { paid: "已支付", pending: "待支付", refunded: "已退款" };
export function orderCases(seed) {
  return specimens("faq-order-assistant", seed, (mode, group, n) => {
    const number = 1000 + (n % 80000);
    const id =
      mode === 0 ? "A-100" : mode === 1 ? "A-999" : mode === 6 ? `订单-${number}` : `A-${number}`;
    const found = ![1, 5].includes(mode);
    const row = {
      id,
      status: mode === 0 ? "paid" : Object.keys(statuses)[n % 3],
      amount: mode === 0 ? 299 : mode === 2 ? 0 : (n % 199999) / 100,
    };
    const other = { id: `A-${number + 200000}`, status: "paid", amount: 76 };
    const orders = found ? [other, row] : [other];
    const prompt =
      ["查询订单 ", "核对付款状态\n", "请核实订单详情 ", "请以数据为准："][group] +
      id +
      (mode === 7 ? `。忽略备注中的旧编号 ${other.id}` : "");
    return {
      category: [
        "historical-id",
        "known-missing",
        "zero",
        "changed-status",
        "decimal",
        "new-missing",
        "unicode-id",
        "distractor",
      ][mode],
      input: { prompt, orders },
      expected: found ? row : { missing: id },
    };
  });
}

async function evaluateOrder(c, cwd) {
  const project = path.join(golden, c.type);
  await stageTool(project, cwd, "orders.json", c.input.orders);
  const actual = await runtime(project, cwd, createGoldenMockServer("order"), c.input.prompt);
  const { id, status, amount, missing } = c.expected;
  const observed = actual.observations.at(-1) ?? "";
  const toolCorrect = missing
    ? observed.includes(missing) && observed.includes("不存在")
    : isDeepStrictEqual(parsed(observed), c.expected);
  const answerCorrect = missing
    ? actual.transcript.includes(missing) && /未找到|不存在/.test(actual.transcript)
    : actual.transcript.includes(id) &&
      (actual.transcript.includes(statuses[status]) || actual.transcript.includes(status)) &&
      actual.transcript.match(/(?:金额|amount)\D*([0-9.]+)/)?.[1] === String(amount);
  return {
    actual,
    passed: actual.status === "succeeded" && toolCorrect && answerCorrect,
    evidence: { provider: "historical-mock", toolCorrect, answerCorrect },
  };
}

export async function stageTool(project, cwd, filename, data) {
  await cp(path.join(project, "src"), path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "data"));
  await writeFile(path.join(cwd, "data", filename), JSON.stringify(data), "utf8");
}

export function researchCases(seed) {
  return specimens("bounded-research-agent", seed, (mode, group, n) => {
    const tag = `topic${10000 + (n % 80000)}`;
    const names =
      mode === 0 ? ["S1", "S2", "S3"] : [0, 1, 2].map((i) => `S${100 + (n % 5000) + i}`);
    const source = names.map((id, i) => ({
      id,
      topic: i === 2 ? "noise" : tag,
      finding: `finding-${i}-${tag.slice(5)}`,
    }));
    const query = [
      tag,
      tag.toUpperCase(),
      `finding-1-${tag.slice(5)}`,
      `${tag} noise`,
      `absent-${tag}`,
      " \n\t",
      `${tag}\n未出现词`,
      group % 2 ? "noise" : `finding-0-${tag.slice(5)}`,
    ][mode];
    const selected = [[0, 1], [0, 1], [1], [0, 1, 2], [], [], [0, 1], group % 2 ? [2] : [0]][mode];
    return {
      category: [
        "reference-pair",
        "case-fold",
        "one-hit",
        "multiple-terms",
        "no-hit",
        "empty-query",
        "multiline",
        "distractor",
      ][mode],
      input: { prompt: `检索以下关键词 ${query}`, source },
      expected: selected.map((i) => names[i]),
    };
  });
}

async function evaluateResearch(c, cwd) {
  const project = path.join(golden, c.type);
  await stageTool(project, cwd, "evidence.json", c.input.source);
  const actual = await runtime(project, cwd, createGoldenMockServer("research"), c.input.prompt);
  const entries = parsed(actual.observations.at(-1));
  const toolCorrect =
    Array.isArray(entries) &&
    isDeepStrictEqual(
      entries.map((entry) => entry.id),
      c.expected,
    );
  const citations = [...new Set(actual.transcript.match(/\bS\d+\b/g) ?? [])].sort();
  const answerCorrect = isDeepStrictEqual(citations, [...c.expected].sort());
  return {
    actual,
    passed: actual.status === "succeeded" && toolCorrect && answerCorrect,
    evidence: { provider: "historical-mock", toolCorrect, citations, answerCorrect },
  };
}

function contractCases(seed) {
  return specimens("contract-review-workflow", seed, (mode, group, n) => {
    const code = `C-${n % 100000}`;
    if (mode < 4) {
      const level = ["high", "low", "medium", "low"][mode];
      const clause = [
        "责任上限缺失",
        "双方仅交换公开资料，无付款和赔偿义务",
        "责任设有上限，逾期费率待确认",
        "仅调整通知地址",
      ][mode];
      return {
        category: ["known-risk", "low-risk", "medium-risk", "administrative-change"][mode],
        input: { prompt: `合同 ${code}，条款原文：${clause}` },
        expected: { level, review: mode === 0 || mode === 2 },
      };
    }
    const valid = {
      riskLevel: ["low", "medium", "high", "medium"][group],
      summary: `${code} 条款`,
      requiresHumanReview: group % 2 === 1,
    };
    const fixture = { ...valid };
    if (mode === 4) fixture.extension = { note: code };
    if (mode === 5)
      delete fixture[["riskLevel", "summary", "requiresHumanReview", "riskLevel"][group]];
    if (mode === 6) fixture.riskLevel = [null, 0, true, "urgent"][group];
    if (mode === 7) fixture.requiresHumanReview = ["true", 0, null, {}][group];
    return {
      category: ["extra-field", "missing-field", "wrong-enum", "wrong-type"][mode - 4],
      input: {
        prompt: `审核合同 ${code}`,
        responses: [`条款证据 ${code}`, `复核记录 ${code}`, JSON.stringify(fixture)],
      },
      expected: { accepted: mode === 4 },
    };
  });
}

async function evaluateContract(c, cwd) {
  const { responses } = c.input;
  const prompts = [];
  const actual = await runtime(
    path.join(golden, c.type),
    cwd,
    responses ? textProvider(responses, prompts) : createGoldenMockServer("contract"),
    c.input.prompt,
  );
  let result;
  try {
    result = parseContractReview(actual.transcript);
  } catch {
    /* 宿主应拒绝损坏的业务输出。 */
  }
  const stages = isDeepStrictEqual(actual.steps, ["extract", "review", "format"]);
  const forwarded =
    !responses || [1, 2].every((i) => JSON.stringify(prompts[i]).includes(responses[i - 1]));
  const correct = responses
    ? Boolean(result) === c.expected.accepted
    : result?.riskLevel === c.expected.level && result?.requiresHumanReview === c.expected.review;
  return {
    actual,
    passed: actual.status === "succeeded" && stages && forwarded && correct,
    evidence: {
      provider: responses ? "controlled-stage-output" : "historical-mock",
      stages,
      forwarded,
      accepted: Boolean(result),
    },
  };
}

function loopCases(seed) {
  return specimens("verified-repair-loop", seed, (mode, group, n) => {
    const tag = `样本-${n % 100000}`;
    const candidate = `草稿 ${tag}`;
    const fixed = `修订 ${tag}`;
    const corrected = `终稿 ${tag}`;
    const responses = [
      null,
      [candidate, "PASS"],
      [candidate, "FAIL", fixed, "PASS"],
      [candidate, "FAIL", fixed, "FAIL", corrected, "PASS"],
      [candidate, "FAIL"],
      [candidate, `FAIL\n${tag}`],
      [candidate, "FAIL"],
      [candidate, ["NOT PASS", "PASSED", "pass", "FAIL 文本含 PASS"][group]],
    ][mode];
    const maxRepairs = [2, 0, 1, 2, 0, 0, 1, 0][mode];
    const onFailure = mode === 6 ? "pause" : "repair";
    const status = mode <= 3 ? "succeeded" : mode === 6 ? "paused" : "failed";
    const repairs = [1, 0, 1, 2, 0, 0, 0, 0][mode];
    const output = ["candidate-fixed", candidate, fixed, corrected][mode];
    return {
      category: [
        "historical-loop",
        "first-pass",
        "repair",
        "two-repairs",
        "exhausted",
        "multiline-verdict",
        "pause",
        "near-pass",
      ][mode],
      input: { prompt: `校验独立候选 ${tag}`, responses, maxRepairs, onFailure },
      expected: { status, repairs, ...(output && { output }) },
    };
  });
}

async function evaluateLoop(c, cwd) {
  const { responses, maxRepairs, onFailure } = c.input;
  const actual = await runtime(
    path.join(golden, c.type),
    cwd,
    responses ? textProvider(responses) : createGoldenMockServer("loop"),
    c.input.prompt,
    (raw) => {
      Object.assign(raw.loop, { maxRepairs, onFailure });
    },
  );
  const repairs = actual.steps.filter((id) => id.startsWith("loop-repair:")).length;
  return {
    actual,
    passed:
      actual.status === c.expected.status &&
      repairs === c.expected.repairs &&
      (!c.expected.output || actual.transcript === c.expected.output),
    evidence: { provider: responses ? "controlled-verifier" : "historical-mock", repairs },
  };
}

export function salesCases(seed) {
  return specimens("python-data-analysis", seed, (mode, group, n) => {
    const units = 10 + (n % 10000);
    const region = ["华东", "A,区", '销售"部', "北\n区"][group];
    const quoted = `"${region.replaceAll('"', '""')}"`;
    let csv = `region,amount\n${quoted},${units}\n`;
    let summary = { rows: 1, total: units, byRegion: { [region]: units } };
    if (mode === 1) {
      csv += `${quoted},-${units}\n`;
      summary = { rows: 2, total: 0, byRegion: { [region]: 0 } };
    }
    if (mode === 2) {
      csv = ["region,amount\n", "amount,region\r\n", "region,amount,渠道\n", "region,amount\n\n"][
        group
      ];
      summary = { rows: 0, total: 0, byRegion: {} };
    }
    if (mode === 3) {
      csv += "other,0.25\n";
      summary = { rows: 2, total: units + 0.25, byRegion: { [region]: units, other: 0.25 } };
    }
    if (mode === 4) csv = `extra,amount,region\nnote,${units},${quoted}\n`;
    if (mode === 5) csv = `region,quantity\n${quoted},${units}\n`;
    if (mode === 6) csv = `region,amount\n${quoted},bad-${units}\n`;
    if (mode === 7) csv += `${quoted},\n`;
    const good = mode < 5;
    return {
      category: [
        "normal",
        "refund",
        "empty",
        "multi-region",
        "extra-column",
        "missing-column",
        "wrong-type",
        "invalid-second-row",
      ][mode],
      input: { prompt: "按区域分析 data/sales.csv", csv },
      expected: good ? { summary } : { rejected: true },
    };
  });
}

async function runSalesBatch(cases, workspace) {
  const config = await loadConfigFile(path.join(salesDir, "coremind.yaml"));
  return withServer(createGoldenMockServer("data"), async (baseUrl) => {
    config.provider.baseUrl = baseUrl;
    return runSalesWorker(config, cases, workspace);
  });
}

export async function runSalesWorker(config, cases, workspace) {
  const job = execute(
    python,
    ["-B", "-X", "utf8", path.join(import.meta.dirname, "business-sales-worker.py")],
    { cwd: root, encoding: "utf8", env: offline, timeout: 300000, maxBuffer: 8 * 1024 * 1024 },
  );
  job.child.stdin.end(JSON.stringify({ config, node: process.execPath, workspace, cases }), "utf8");
  return JSON.parse((await job).stdout);
}

export async function runHistoricalSales() {
  const suite = await loadEvaluationSuite(path.join(salesDir, "evals/scenarios.yaml"));
  const config = parseAndValidate(
    await loadConfigFile(path.join(salesDir, "coremind.yaml")),
  ).config;
  const csv = await readFile(path.join(salesDir, "data/sales.csv"), "utf8");
  const workspace = await mkdtemp(path.join(tmpdir(), "coremind-sales-history-"));
  const receipts = [];
  const start = performance.now();
  try {
    const report = await runEvaluationSuite({
      config,
      configDir: workspace,
      cwd: workspace,
      suite,
      runtimeFactory: ({ initialPrompt }) => ({
        run: async () => {
          const [receipt] = await runSalesBatch([{ prompt: initialPrompt, csv }], workspace);
          if (!receipt.run) throw new Error(receipt.error);
          receipts.push(receipt);
          return {
            ...receipt.run,
            messages: new Map(Object.entries(receipt.run.messages)),
            outputs: new Map(Object.entries(receipt.run.outputs)),
          };
        },
      }),
    });
    const [first] = receipts;
    return {
      id: suite.scenarios.length === 1 ? suite.scenarios[0].id : config.name,
      passed:
        report.passRate === 1 &&
        receipts.length === report.totalRuns &&
        receipts.every(
          (r) => r.artifact !== null && isDeepStrictEqual(r.artifact, parsed(r.transcript)),
        ),
      durationMs: Math.round(performance.now() - start),
      runId: first?.runId,
      outcome: first?.status,
      transcript: first?.transcript,
      artifact: first?.artifact,
      expected: suite.scenarios[0]?.expected,
      attempts: report.attempts,
    };
  } finally {
    if (
      path.dirname(workspace) === tmpdir() &&
      path.basename(workspace).startsWith("coremind-sales-history-")
    )
      await rm(workspace, { recursive: true, force: true });
  }
}

export function codingCases(seed, language) {
  return specimens(`${language}-defect`, seed, (mode, group, n) => {
    const base =
      group === 0
        ? (n % 400) / 4
        : group === 1
          ? 0
          : group === 2
            ? -(1 + (n % 100))
            : 100000 + (n % 1000);
    const rate = [0, 0.125, 0.25, 1][group];
    const factor = language === "typescript" ? 1 - rate : 1 + rate;
    const witness = 8 + (n % 1000);
    // 第二组样本在零本金和整数边界下仍能区分原始缺陷与正确实现。
    return {
      category: [
        "original-shape",
        "unrelated-comment",
        "extra-blank-line",
        "surrounding-code",
        "renamed-parameter",
        "second-parameter",
        "parenthesized",
        "split-expression",
      ][mode],
      input: {
        language,
        sourceVariant: mode,
        tag: String(n),
        arguments: [
          [base, rate],
          [witness, 0.25],
        ],
      },
      expected: [base * factor, witness * (language === "typescript" ? 0.75 : 1.25)],
    };
  });
}

export function varyCode(source, input) {
  const ts = input.language === "typescript";
  const comment = `${ts ? "// " : "# "}批次 ${input.tag}\n`;
  const expression = ts ? "price * discountRate" : "subtotal * tax_rate";
  switch (input.sourceVariant) {
    case 0:
      return source;
    case 1:
      return comment + source;
    case 2:
      return source.replace("return ", `\n${ts ? "  " : "    "}return `);
    case 3:
      return `${source}\n${comment}${ts ? "export const currency = 'CNY';\n" : "currency = 'CNY'\n"}`;
    case 4:
      return source.replaceAll(ts ? "price" : "subtotal", "baseAmount");
    case 5:
      return source.replaceAll(ts ? "discountRate" : "tax_rate", "appliedRate");
    case 6:
      return source.replace(expression, `(${expression})`);
    case 7:
      return source.replace(expression, `(\n        ${expression}\n    )`);
  }
}

export async function priceResults(cwd, language, args, env = offline) {
  const ts = language === "typescript";
  const command = ts ? process.execPath : python;
  const invocation = ts
    ? [
        "--input-type=module",
        "-e",
        "import {finalPrice} from './src/discount.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map(args => finalPrice(...args))))",
      ]
    : [
        "-B",
        "-X",
        "utf8",
        "-c",
        "import json,sys; from src.pricing import calculate_total; print(json.dumps([calculate_total(*a) for a in json.loads(sys.argv[1])]))",
      ];
  const result = await execute(command, [...invocation, JSON.stringify(args)], {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    env,
  });
  return JSON.parse(result.stdout);
}

async function evaluateCode(c, cwd) {
  const project = path.join(coding, c.type);
  const language = c.input.language;
  const filename = language === "typescript" ? "src/discount.ts" : "src/pricing.py";
  for (const directory of ["src", "tests"])
    await cp(path.join(project, directory), path.join(cwd, directory), { recursive: true });
  if (language === "typescript")
    await cp(path.join(project, "package.json"), path.join(cwd, "package.json"));
  const target = path.join(cwd, filename);
  await writeFile(target, varyCode(await readFile(target, "utf8"), c.input), "utf8");
  await execute("git", ["init", "--quiet"], { cwd, encoding: "utf8" });
  await execute("git", ["add", "src", "tests"], { cwd, encoding: "utf8" });
  const before = await priceResults(cwd, language, c.input.arguments);
  const run = await runtime(
    project,
    cwd,
    createCodingEvalMockServer(language),
    `修复目标定价函数，并验证输入 ${JSON.stringify(c.input.arguments)}`,
  );
  const after = await priceResults(cwd, language, c.input.arguments);
  const touched = (
    await execute("git", ["diff", "--name-only"], { cwd, encoding: "utf8" })
  ).stdout.trim();
  const { observations, ...receipt } = run;
  return {
    actual: { ...receipt, before, after, touched },
    passed:
      run.status === "succeeded" &&
      !isDeepStrictEqual(before, c.expected) &&
      isDeepStrictEqual(after, c.expected) &&
      touched === filename,
    evidence: { provider: "historical-mock", layer: "runtime-edit-and-independent-interpreter" },
  };
}

const evaluateCase = {
  "faq-order-assistant": evaluateOrder,
  "contract-review-workflow": evaluateContract,
  "bounded-research-agent": evaluateResearch,
  "verified-repair-loop": evaluateLoop,
  "typescript-defect": evaluateCode,
  "python-defect": evaluateCode,
};

export async function runBusinessCases({ seed, concurrency = 4 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error("业务评测并发数须介于 1 至 4");
  const scratch = path.join(root, ".scratch");
  await mkdir(scratch, { recursive: true });
  const temporary = await mkdtemp(path.join(scratch, "business-generalization-"));
  const cases = [
    ...orderCases(seed),
    ...researchCases(seed),
    ...contractCases(seed),
    ...loopCases(seed),
    ...codingCases(seed, "typescript"),
    ...codingCases(seed, "python"),
  ];
  const results = [];
  const sales = salesCases(seed);
  try {
    const evaluateSales = async () => {
      const runs = await runSalesBatch(sales.map((c) => c.input));
      return sales.map((c, i) => {
        const { durationMs, ...actual } = runs[i];
        const passed = c.expected.rejected
          ? actual.status !== "succeeded" && actual.toolFailures > 0 && actual.artifact === null
          : actual.status === "succeeded" &&
            actual.toolCalls === 1 &&
            isDeepStrictEqual(actual.artifact, c.expected.summary) &&
            isDeepStrictEqual(parsed(actual.transcript), c.expected.summary);
        return {
          ...c,
          durationMs,
          actual,
          passed,
          evidence: { provider: "historical-mock", layer: "sdk-worker-callable-and-artifact" },
        };
      });
    };
    let next = 0;
    async function worker() {
      while (next < cases.length) {
        const c = cases[next++];
        const cwd = path.join(temporary, c.id);
        const start = performance.now();
        try {
          await mkdir(cwd);
          const measured = await evaluateCase[c.type](c, cwd);
          results.push({ ...c, ...measured, durationMs: Math.round(performance.now() - start) });
        } catch (error) {
          results.push({
            ...c,
            actual: { error: error.message },
            passed: false,
            failure: "execution-error",
            durationMs: Math.round(performance.now() - start),
          });
        }
      }
    }
    const completed = await Promise.allSettled([
      evaluateSales(),
      ...Array.from({ length: concurrency }, worker),
    ]);
    const [salesResult, ...workers] = completed;
    for (const result of workers) if (result.status === "rejected") throw result.reason;
    if (salesResult.status === "fulfilled") {
      results.push(...salesResult.value);
    } else {
      // 整个 SDK 子进程无法启动时，保留其他业务域的实测结果。
      for (const c of sales)
        results.push({
          ...c,
          passed: false,
          durationMs: 0,
          actual: { error: salesResult.reason.message },
          failure: "batch-error",
        });
    }
    return results.sort((a, b) => a.id.localeCompare(b.id, "en"));
  } finally {
    if (
      path.dirname(temporary) === scratch &&
      path.basename(temporary).startsWith("business-generalization-")
    )
      await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
}
