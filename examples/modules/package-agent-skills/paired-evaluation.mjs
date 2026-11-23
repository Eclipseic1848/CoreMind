import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const project = path.dirname(fileURLToPath(import.meta.url));
const evidenceRoot = path.resolve(project, "../../../.scratch/p2/skill-sharing/live-eval");
const cases = JSON.parse(await readFile(path.join(project, "cases.json"), "utf8"));
const skillIds = [...new Set(cases.flatMap(({ skill }) => (skill ? [skill] : [])))];
const systemPrompt =
  "你负责处理用户要求的办公任务。如果标准技能索引中有适用技能，先读正文并按需读取资源。只使用用户提供或授权工具读取的事实，按用户要求输出。";
const agentOptions = { temperature: 0, maxTokens: 512, thinkingLevel: "off" };
const limits = {
  maxTurns: 8,
  maxSteps: 1,
  maxToolCalls: 7,
  maxToolFailures: 2,
  maxRetries: 0,
  maxTokens: 18_000,
  stepTimeoutMs: 55_000,
  runTimeoutMs: 60_000,
};
const totalTimeoutMs = 6 * 60_000;
const rubric = {
  format: "输出为纯 JSON 对象或单个 JSON 代码块，且顶层字段集合精确匹配预期。",
  facts:
    "四个业务任务按字段与预期值作深度比较。摘要允许改写，但须保留资料室、下周一上午、门禁更换、暂不开放与下午恢复五项事实。",
  workflow: "启用且相关时先读对应正文，并成功读取题目要求的全部资源。禁用或无关时无工具调用。",
  passed: "运行成功，格式、全部字段及工具流程均通过。",
};

const mode = process.argv[2];
if (mode === "--plan") {
  console.log(
    JSON.stringify({ systemPrompt, agentOptions, limits, totalTimeoutMs, rubric, cases }, null, 2),
  );
} else if (mode === "--run") {
  const selectedIds = process.argv.slice(3);
  const selected = selectedIds.length ? cases.filter(({ id }) => selectedIds.includes(id)) : cases;
  assert(
    selected.length && (!selectedIds.length || selected.length === selectedIds.length),
    "题目 ID 无效或重复",
  );
  await runEvaluation(selected);
} else if (mode === "--rescore" && process.argv[3]) {
  const recorded = JSON.parse(await readFile(process.argv[3], "utf8"));
  const scores = recorded.attempts.map((attempt) => {
    const { caseId, enabled, score: originalScore, calls, skillLoads } = attempt;
    const item = recorded.cases.find(({ id }) => id === caseId);
    return {
      caseId,
      enabled,
      originalScore,
      score: score(item, enabled, attempt, calls, skillLoads),
    };
  });
  console.log(JSON.stringify({ rubric, scores }, null, 2));
} else {
  throw new Error("使用 --plan 查看评分，--run 运行真实模型，--rescore <报告路径> 离线复核评分");
}

async function runEvaluation(selected) {
  const baseUrl = process.env.COREMIND_SKILL_EVAL_BASE_URL;
  const model = process.env.COREMIND_SKILL_EVAL_MODEL;
  assert(baseUrl && model, "请设置 COREMIND_SKILL_EVAL_BASE_URL 和 COREMIND_SKILL_EVAL_MODEL");
  const endpoint = new URL(baseUrl);
  assert(
    ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      !endpoint.search &&
      !endpoint.hash,
    "评测端点须使用不含凭据的 HTTP(S) URL",
  );

  const { CoreMindRuntime, FileRunStore, parseAndValidate } = await import("coremind-ai");
  const { readStandardSkillPackage } = await import("coremind-templates/internal");
  const packageEvidence = {};
  for (const id of skillIds) {
    const { skill, source, manifest } = await readStandardSkillPackage(
      path.join(project, "skills", id),
      id,
    );
    assert(manifest && skill.resources, `评测包 ${id} 缺少资源清单`);
    packageEvidence[id] = {
      version: skill.packageVersion,
      sourceSha256: hash(source),
      manifestSha256: hash(manifest),
      resources: Object.fromEntries(skill.resources.map(({ path, sha256 }) => [path, sha256])),
    };
  }
  for (const item of cases) {
    assert(
      item.resources.every((resource) => packageEvidence[item.skill]?.resources[resource]),
      item.id,
    );
  }

  const provider = {
    id: "skill-eval-local",
    baseUrl,
    model,
    thinkingFormat: "qwen",
    maxTokens: 512,
  };
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    provider,
    systemPrompt,
    agentOptions,
    limits,
    totalTimeoutMs,
    rubric,
    cases: selected,
    packages: packageEvidence,
    attempts: [],
  };
  await mkdir(evidenceRoot, { recursive: true });
  const directory = await mkdtemp(path.join(evidenceRoot, "paired-"));
  const runStore = new FileRunStore(path.join(directory, "runs"));
  const destination = path.join(directory, "report.json");
  const save = async () => {
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await rename(temporary, destination);
  };
  await save();
  console.log(`评测证据 ${destination}`);

  const signal = AbortSignal.timeout(totalTimeoutMs);
  try {
    for (const item of selected) {
      const index = cases.indexOf(item);
      const arms = index % 2 === 0 ? [false, true] : [true, false];
      for (const enabled of arms) {
        signal.throwIfAborted();
        const { config } = parseAndValidate({
          schemaVersion: 3,
          name: "Skill 资源成对评测",
          provider,
          agents: {
            main: { systemPrompt, options: agentOptions, skills: enabled ? skillIds : [] },
          },
          defaultAgent: "main",
          tools: [],
          permissions: { mode: "ask", allow: ["load_skill"], network: "deny", workspaceOnly: true },
          session: { enabled: false },
          runtime: limits,
        });
        const runtime = await CoreMindRuntime.create({
          config,
          configDir: project,
          cwd: directory,
          env: {},
          initialPrompt: item.prompt,
          runStore,
          signal,
        });
        const result = await runtime.run();
        const events = result.trace.map(({ event }) => event);
        const results = new Map(
          events.filter(({ type }) => type === "tool_result").map((event) => [event.callId, event]),
        );
        const calls = events
          .filter(({ type }) => type === "tool_call")
          .map(({ callId, tool, args }) => ({
            callId,
            tool,
            args,
            succeeded: results.get(callId)?.isError === false,
          }));
        const facts = (await runStore.read(result.runId)).flatMap(({ payload, sequence }) =>
          payload?.skillLoad ? [{ ...payload.skillLoad, sequence }] : [],
        );
        const scored = score(item, enabled, result, calls, facts);
        const { durationMs, tokens, context } = result.metrics;
        report.attempts.push({
          caseId: item.id,
          enabled,
          runId: result.runId,
          outcome: result.outcome,
          score: scored,
          durationMs,
          tokens: tokens ?? null,
          inputTokens: tokens === undefined ? null : (context?.inputTokens ?? null),
          outputTokens: tokens === undefined ? null : (context?.outputTokens ?? null),
          calls,
          skillLoads: facts,
          transcript: result.transcript,
        });
        await save();
        console.log(
          `${item.id} ${enabled ? "启用" : "禁用"} ${result.outcome.status} 评分=${scored.passed} 耗时=${durationMs}ms`,
        );
        if (
          ["provider_transient", "durability_unsupported"].includes(result.outcome.finishReason) ||
          signal.aborted
        ) {
          throw new Error(`评测无法继续：${result.outcome.finishReason}`);
        }
      }
    }
  } finally {
    report.completedAt = new Date().toISOString();
    report.complete = report.attempts.length === selected.length * 2;
    await save();
  }
}

function score(item, enabled, result, calls, receipts) {
  const output = parseOutput(result.transcript);
  const keys = Object.keys(item.expected);
  const format = isDeepStrictEqual(Object.keys(output ?? {}).sort(), keys.sort());
  const facts = Object.fromEntries(
    keys.map((key) => [key, isDeepStrictEqual(output?.[key], item.expected[key])]),
  );
  if (item.id === "ordinary-summary" && typeof output?.摘要 === "string") {
    facts.摘要 = [
      /资料室/u,
      /下周一(?:的)?上午/u,
      /更换门禁|门禁更换/u,
      /暂停开放|临时关闭|暂不开放/u,
      /下午[^，。；]{0,8}(?:恢复开放|重新开放)|下午恢复(?=[。；，！？.!?]|$)/u,
    ].every((pattern) => pattern.test(output.摘要));
  }
  const requiredSkill = enabled ? item.skill : null;
  const workflow = requiredSkill
    ? receipts[0]?.id === requiredSkill &&
      receipts[0].delivery === "body" &&
      item.resources.every((resource) =>
        receipts.some((receipt) => receipt.id === requiredSkill && receipt.resource === resource),
      ) &&
      calls.every(
        ({ tool, args, succeeded }) =>
          tool === "load_skill" &&
          succeeded &&
          args.id === requiredSkill &&
          (args.resource === undefined || item.resources.includes(args.resource)),
      )
    : calls.length === 0 && receipts.length === 0;
  const passed =
    result.outcome.status === "succeeded" &&
    format &&
    Object.values(facts).every(Boolean) &&
    workflow;
  return { format, facts, workflow, passed };
}

function parseOutput(output) {
  const text = output.trim();
  const fenced = text.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu);
  try {
    const result = JSON.parse(fenced?.[1] ?? text);
    return result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
  } catch {
    return undefined;
  }
}

function hash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
