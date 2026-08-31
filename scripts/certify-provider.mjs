import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAndValidate } from "../packages/coremind-config/dist/index.js";
import {
  ChatSession,
  CoreMindRuntime,
  defineTool,
  FileRunStore,
} from "../packages/coremind-runtime/dist/index.js";
import {
  assertCertificationSucceeded,
  createCertificationEvidence,
  inspectCandidateManifest,
  upsertCertificationRecord,
  validateCertificationApproval,
  verifyCandidateArtifact,
} from "./provider-certification.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testedAt = new Date().toISOString();
const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const runtimeArtifactSha256 = hash(
  await readFile(path.join(root, "packages", "coremind-runtime", "dist", "index.js")),
);
const candidateManifestPath = process.env.COREMIND_CERT_CANDIDATE_MANIFEST;
if (!candidateManifestPath) throw new Error("缺少候选制品清单：COREMIND_CERT_CANDIDATE_MANIFEST");
const candidateManifestAbsolute = path.resolve(root, candidateManifestPath);
const candidateManifestRaw = await readFile(candidateManifestAbsolute, "utf8");
const candidate = inspectCandidateManifest(candidateManifestRaw, {
  version,
  commit,
  runtimeArtifactSha256: process.env.COREMIND_CERT_EXPECTED_RUNTIME_SHA256,
});
verifyCandidateArtifact(
  await readFile(
    path.join(path.dirname(candidateManifestAbsolute), candidate.candidateArtifactPath),
  ),
  candidate.candidateArtifactSha256,
);
const approval = validateCertificationApproval(
  {
    provider: process.env.COREMIND_CERT_PROVIDER,
    model: process.env.COREMIND_CERT_MODEL,
    credentialEnv: process.env.COREMIND_CERT_API_KEY_ENV,
    maxCostUsd: process.env.COREMIND_CERT_MAX_COST_USD,
    maxDurationMinutes: process.env.COREMIND_CERT_MAX_DURATION_MINUTES,
    expectedVersion: process.env.COREMIND_CERT_EXPECTED_VERSION,
    expectedCommit: process.env.COREMIND_CERT_EXPECTED_COMMIT,
    expectedRuntimeArtifactSha256: process.env.COREMIND_CERT_EXPECTED_RUNTIME_SHA256,
  },
  {
    version,
    commit,
    runtimeArtifactSha256: candidate.candidateArtifactSha256,
  },
);
const providerId = approval.provider;
const model = approval.model;
const apiKeyEnv = approval.credentialEnv;
const originalKey = process.env[apiKeyEnv];
if (!originalKey) throw new Error(`缺少认证密钥环境变量：${apiKeyEnv}`);
const workerManifest = JSON.parse(
  await readFile(path.join(root, "python", "src", "coremind", "_worker", "manifest.json"), "utf8"),
);
const runtimeDigest = `sha256:${workerManifest.bundleSha256}`;
const certificationRoot = await mkdtemp(path.join(tmpdir(), "coremind-provider-certification-"));
const workspace = path.join(certificationRoot, "workspace");
await mkdir(workspace, { recursive: true });
const runStore = new FileRunStore(path.join(certificationRoot, "runs"));
const startedAtMs = Date.now();
const deadline = new AbortController();
const deadlineTimer = setTimeout(
  () => deadline.abort(new Error("Provider 认证超过人工批准的最长运行时间")),
  approval.maxDurationMs,
);
const certificationEvents = [];
let accumulatedCostUsd = 0;

const details = {};
try {
  const basicEvents = [];
  const basic = await createRuntime({
    prompt: '只输出 JSON：{"status":"ok","marker":"CM-CERT-2026"}',
    events: (event) => basicEvents.push(event),
  });
  const basicResult = await basic.run();
  assertCertificationSucceeded(basicResult, "流式与结构化结果", [originalKey]);
  const structured = parseJsonObject(basicResult.transcript);
  if (structured.status !== "ok" || structured.marker !== "CM-CERT-2026") {
    throw new Error("结构化结果字段不符合预期");
  }
  const deltaCount = basicEvents.filter((event) => event.type === "text_delta").length;
  if (deltaCount < 1) throw new Error("没有收到流式文本事件");
  details.streaming = { passed: true, deltaCount };
  details.structuredResult = { passed: true, outputHash: hash(basicResult.transcript) };

  const tool = defineTool({
    name: "lookup_certification_marker",
    description: "返回认证标记。必须先调用此工具，不能自行猜测标记。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    effect: { operations: ["read"], reversible: true },
    execute: () => ({ text: "TOOL-CERT-4271" }),
  });
  const toolEvents = [];
  const toolRuntime = await createRuntime({
    prompt: "请调用 lookup_certification_marker 工具，并原样输出工具返回的标记。",
    events: (event) => toolEvents.push(event),
    toolDefinitions: [tool],
  });
  const toolResult = await toolRuntime.run();
  assertCertificationSucceeded(toolResult, "工具调用", [originalKey]);
  const called = toolEvents.some(
    (event) => event.type === "tool_call" && event.tool === "lookup_certification_marker",
  );
  const returned = toolEvents.some(
    (event) => event.type === "tool_result" && event.tool === "lookup_certification_marker",
  );
  if (!called || !returned || !toolResult.transcript.includes("TOOL-CERT-4271")) {
    throw new Error("工具调用链不完整");
  }
  details.toolCall = { passed: true, calls: toolResult.metrics.toolCalls };

  details.childRun = await certifyChildRunSuccess();
  details.childRunCancel = await certifyChildRunCancellation();

  const chatRuntime = await createRuntime({});
  const session = new ChatSession(chatRuntime, "assistant");
  const firstTurn = await session.chat("记住合成测试代码 SESSION-CERT-8319，只回复已记住。");
  const secondTurn = await session.chat("我刚才要求你记住的代码是什么？只回复代码。");
  const thirdTurn = await session.chat("请再次只回复刚才的合成测试代码。");
  assertCertificationSucceeded(firstTurn.run, "多轮第一轮", [originalKey]);
  assertCertificationSucceeded(secondTurn.run, "多轮第二轮", [originalKey]);
  assertCertificationSucceeded(thirdTurn.run, "多轮第三轮", [originalKey]);
  if (
    !secondTurn.text.includes("SESSION-CERT-8319") ||
    !thirdTurn.text.includes("SESSION-CERT-8319")
  ) {
    throw new Error("多轮上下文未保持");
  }
  details.multiTurn = { passed: true, turns: 3, outputHash: hash(thirdTurn.text) };

  const abortController = new AbortController();
  const abortRuntime = await createRuntime({
    prompt: "请生成一篇至少五千字、分二十节的纯合成技术文章。",
    signal: abortController.signal,
  });
  const abortTimer = setTimeout(() => abortController.abort(), 50);
  const abortResult = await abortRuntime.run();
  clearTimeout(abortTimer);
  if (abortResult.outcome.status !== "aborted") {
    throw new Error(`中止未映射为 aborted：${abortResult.outcome.status}`);
  }
  details.abort = { passed: true, status: abortResult.outcome.status };

  const longContextChars = Number(process.env.COREMIND_CERT_LONG_CONTEXT_CHARS ?? 64_000);
  if (
    !Number.isInteger(longContextChars) ||
    longContextChars < 10_000 ||
    longContextChars > 250_000
  ) {
    throw new Error("COREMIND_CERT_LONG_CONTEXT_CHARS 必须是 10000 到 250000 的整数");
  }
  const longContextMarker = "LONG-CONTEXT-CERT-6197";
  const fillerUnit = "这是只包含合成内容的长上下文认证段落，不含任何用户或业务数据。";
  const filler = fillerUnit
    .repeat(Math.ceil(longContextChars / fillerUnit.length))
    .slice(0, longContextChars);
  const longContextRuntime = await createRuntime({
    prompt: `记住标记 ${longContextMarker}。阅读以下合成长文本后，只输出该标记。\n${filler}\n现在只输出标记。`,
  });
  const longContextResult = await longContextRuntime.run();
  assertCertificationSucceeded(longContextResult, "长上下文", [originalKey]);
  if (!longContextResult.transcript.includes(longContextMarker)) {
    throw new Error("长上下文末端未返回预期标记");
  }
  details.longContext = {
    passed: true,
    inputChars: longContextChars,
    outputHash: hash(longContextResult.transcript),
  };

  process.env[apiKeyEnv] = "invalid-coremind-certification-key";
  const errorRuntime = await createRuntime({ prompt: "只回复 ERROR-CHECK" });
  try {
    const errorResult = await errorRuntime.run();
    if (errorResult.outcome.status === "succeeded") throw new Error("无效密钥被错误标记为成功");
    const serialized = JSON.stringify(errorResult);
    if (serialized.includes("invalid-coremind-certification-key")) {
      throw new Error("错误结果泄露了测试密钥");
    }
    details.error = { passed: true, status: errorResult.outcome.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("invalid-coremind-certification-key")) {
      throw new Error("错误异常泄露了测试密钥");
    }
    if (!/401|invalid.api.key/i.test(message)) throw error;
    details.error = { passed: true, status: "rejected", diagnostic: "authentication_error" };
  }
  process.env[apiKeyEnv] = originalKey;
  const usage = certificationUsage(Date.now() - startedAtMs);
  const ref = process.env.GITHUB_RUN_ID
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : `git:${commit}`;
  const evidence = createCertificationEvidence({
    provider: providerId,
    model,
    version,
    commit,
    runtimeArtifactSha256,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    runtimeDigest,
    artifactManifestDigest: candidate.artifactManifestDigest,
    ref,
    approval,
    usage,
    testedAt,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    details,
  });
  const evidenceJson = `${JSON.stringify(evidence, null, 2)}\n`;
  await assertSecretsAbsent(certificationRoot, [originalKey, "invalid-coremind-certification-key"]);
  assertSecretsAbsentFromText(evidenceJson, [originalKey, "invalid-coremind-certification-key"]);
  const date = testedAt.slice(0, 10);
  const evidenceFile = `${providerId}-${version}-${date}.json`;
  const output = path.join(root, "docs", "providers", "evidence", evidenceFile);
  await mkdir(path.dirname(output), { recursive: true });
  const ledgerPath = path.join(root, "docs", "providers", "certifications.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const evidenceUrl = `https://github.com/Eclipseic1848/CoreMind/blob/main/docs/providers/evidence/${evidenceFile}`;
  const ledgerJson = `${JSON.stringify(
    upsertCertificationRecord(ledger, evidence, evidenceUrl),
    null,
    2,
  )}\n`;
  assertSecretsAbsentFromText(ledgerJson, [originalKey, "invalid-coremind-certification-key"]);
  await writeFile(output, evidenceJson, "utf8");
  await writeFile(ledgerPath, ledgerJson, "utf8");
  console.log(
    `Provider 真实认证通过：${providerId}/${model}，证据：${path.relative(root, output)}`,
  );
} finally {
  process.env[apiKeyEnv] = originalKey;
  clearTimeout(deadlineTimer);
  deadline.abort();
  await rm(certificationRoot, { recursive: true, force: true });
}

async function certifyChildRunSuccess() {
  const scenarioWorkspace = path.join(workspace, "child-success");
  await mkdir(scenarioWorkspace, { recursive: true });
  const task = "CHILD-CERT-SUCCESS-7429";
  const markerPath = "child-certification-marker.txt";
  const marker = "CHILD-TOOL-CERT-7429";
  const events = [];
  const runtime = await createDelegationRuntime({
    scenarioWorkspace,
    parentPrompt: `必须调用 delegate，把任务 ${task} 委派给 worker，references 为空。Child 成功后只回复 PARENT-CHILD-CERT-DONE。不得调用 write。`,
    workerPrompt: `你是认证 Child。必须先调用 write，把 ${marker} 精确写入 ${markerPath}；工具成功后只输出 {"status":"ok","marker":"${marker}"}。`,
    withWrite: true,
    events,
    approveTool: async (request) => {
      const args = request.args ?? {};
      if (
        request.agent === "parent" &&
        request.tool === "delegate" &&
        args.target === "worker" &&
        args.task === task
      ) {
        return "allow";
      }
      if (
        request.agent === "worker" &&
        request.tool === "write" &&
        args.path === markerPath &&
        args.content === marker
      ) {
        return "allow";
      }
      return "deny";
    },
  });
  const result = await runtime.run();
  assertCertificationSucceeded(result, "父子 Agent 产品链", [originalKey]);
  const node = result.childRuns?.nodes[0];
  const parentProviderCalls = countEvents(events, "provider_request", "parent");
  const childProviderCalls = countEvents(events, "provider_request", "worker");
  const delegationToolCalled = hasToolEvent(events, "tool_call", "parent", "delegate");
  const delegationToolCompleted = hasToolEvent(events, "tool_result", "parent", "delegate");
  const childToolCalled = hasToolEvent(events, "tool_call", "worker", "write");
  const childToolCompleted = hasToolEvent(events, "tool_result", "worker", "write");
  const markerWritten =
    (await readFile(path.join(scenarioWorkspace, markerPath), "utf8")) === marker;
  if (
    result.childRuns?.nodes.length !== 1 ||
    node?.status !== "joined" ||
    node.outcome?.status !== "succeeded" ||
    result.childRuns.activeDescendants !== 0 ||
    result.childRuns.quiescent !== true ||
    parentProviderCalls < 1 ||
    childProviderCalls < 1 ||
    !delegationToolCalled ||
    !delegationToolCompleted ||
    !childToolCalled ||
    !childToolCompleted ||
    !markerWritten ||
    !node.result
  ) {
    throw new Error("真实父子 Agent 产品链不完整");
  }
  return {
    passed: true,
    parentProviderCalls,
    delegationToolCalled,
    childProviderCalls,
    childTool: "write",
    childToolCompleted,
    childOutcome: node.outcome.status,
    joined: node.status === "joined",
    quiescent: result.childRuns.quiescent,
    structuredResultSha256: hash(JSON.stringify(node.result)),
  };
}

async function certifyChildRunCancellation() {
  const scenarioWorkspace = path.join(workspace, "child-cancel");
  await mkdir(scenarioWorkspace, { recursive: true });
  const task = "CHILD-CERT-CANCEL-9581";
  const controller = new AbortController();
  const events = [];
  let abortStartedAt;
  const runtime = await createDelegationRuntime({
    scenarioWorkspace,
    parentPrompt: `必须调用 delegate，把任务 ${task} 委派给 worker，references 为空。不得调用其他工具。`,
    workerPrompt: "你是取消认证 Child。立即流式生成至少两万字的纯合成技术文本。",
    events,
    signal: controller.signal,
    approveTool: async (request) => {
      const args = request.args ?? {};
      return request.agent === "parent" &&
        request.tool === "delegate" &&
        args.target === "worker" &&
        args.task === task
        ? "allow"
        : "deny";
    },
    onEvent: (event) => {
      if (abortStartedAt === undefined && event.type === "text_delta" && event.agent === "worker") {
        abortStartedAt = Date.now();
        controller.abort(new Error("认证主动取消 Child Run"));
      }
    },
  });
  const result = await runtime.run();
  if (abortStartedAt === undefined) throw new Error("取消认证没有观察到活动 Child 输出");
  const convergenceMs = Date.now() - abortStartedAt;
  const maxConvergenceMs = Math.min(5_000, approval.maxDurationMs);
  const node = result.childRuns?.nodes[0];
  if (
    !["paused", "aborted"].includes(result.outcome.status) ||
    node?.outcome?.status !== "aborted" ||
    result.childRuns?.activeDescendants !== 0 ||
    convergenceMs > maxConvergenceMs
  ) {
    throw new Error("真实父子 Agent 取消未在批准边界内收敛");
  }
  return {
    passed: true,
    abortTriggeredAt: "child_text_delta",
    parentOutcome: result.outcome.status,
    childOutcome: node.outcome.status,
    activeDescendants: result.childRuns.activeDescendants,
    executionConverged: result.childRuns.activeDescendants === 0,
    convergenceMs,
    maxConvergenceMs,
  };
}

async function createDelegationRuntime({
  scenarioWorkspace,
  parentPrompt,
  workerPrompt,
  withWrite = false,
  events,
  approveTool,
  signal,
  onEvent,
}) {
  const { remainingMs, remainingCostUsd } = remainingApprovalBudget();
  const wallTimeMs = Math.min(120_000, remainingMs);
  const { config } = parseAndValidate({
    schemaVersion: 2,
    name: "provider-child-certification",
    provider: { id: providerId, model, apiKeyEnv },
    agents: {
      parent: {
        systemPrompt: "你是认证父 Agent。只按合成测试任务调用 delegate，不得自行完成 Child 任务。",
        ...(withWrite ? { tools: [{ id: "write" }] } : {}),
        delegation: {
          budget: {
            tokens: 50_000,
            toolCalls: 2,
            costUsd: remainingCostUsd,
            wallTimeMs,
            steps: 6,
            descendants: 1,
          },
          limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 1 },
          targets: {
            worker: {
              budget: {
                tokens: 30_000,
                toolCalls: withWrite ? 1 : 0,
                costUsd: remainingCostUsd,
                wallTimeMs,
                steps: 4,
                descendants: 0,
              },
            },
          },
        },
      },
      worker: {
        systemPrompt: workerPrompt,
        ...(withWrite ? { tools: [{ id: "write" }] } : {}),
      },
    },
    defaultAgent: "parent",
    permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
    runtime: {
      maxTurns: 6,
      maxSteps: 8,
      maxToolCalls: 4,
      maxRetries: approval.maxRetries,
      maxTokens: 80_000,
      maxCostUsd: remainingCostUsd,
      runTimeoutMs: wallTimeMs,
    },
  });
  return CoreMindRuntime.create({
    config,
    configDir: scenarioWorkspace,
    cwd: scenarioWorkspace,
    env: process.env,
    initialPrompt: parentPrompt,
    runStore,
    approveTool,
    events: certificationEventSink((event) => {
      events.push(event);
      onEvent?.(event);
    }),
    signal: signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal,
  });
}

function countEvents(events, type, agent) {
  return events.filter((event) => event.type === type && event.agent === agent).length;
}

function hasToolEvent(events, type, agent, tool) {
  return events.some(
    (event) => event.type === type && event.agent === agent && event.tool === tool,
  );
}

async function createRuntime({ prompt, events, toolDefinitions, signal } = {}) {
  const { remainingMs, remainingCostUsd } = remainingApprovalBudget();
  const { config } = parseAndValidate({
    schemaVersion: 2,
    name: "provider-certification",
    provider: { id: providerId, model, apiKeyEnv },
    agents: {
      assistant: {
        systemPrompt: "你正在执行自动化认证，只处理合成标记，不要求或输出任何其他数据。",
      },
    },
    permissions: { mode: "full" },
    runtime: {
      maxTurns: 6,
      maxSteps: 8,
      maxToolCalls: 2,
      maxRetries: approval.maxRetries,
      maxTokens: 250_000,
      maxCostUsd: remainingCostUsd,
      runTimeoutMs: Math.min(120_000, remainingMs),
    },
  });
  return CoreMindRuntime.create({
    config,
    configDir: workspace,
    cwd: workspace,
    initialPrompt: prompt,
    events: certificationEventSink(events),
    toolDefinitions,
    signal: signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal,
    env: process.env,
    runStore,
  });
}

function remainingApprovalBudget() {
  const remainingMs = approval.maxDurationMs - (Date.now() - startedAtMs);
  const remainingCostUsd = approval.maxCostUsd - accumulatedCostUsd;
  if (remainingMs <= 0 || remainingCostUsd <= 0 || deadline.signal.aborted) {
    throw new Error("Provider 认证已达到人工批准边界");
  }
  return { remainingMs, remainingCostUsd };
}

function certificationEventSink(local) {
  return (event) => {
    certificationEvents.push(event);
    local?.(event);
    if (event.type === "turn_end" && Number.isFinite(event.costUsd)) {
      accumulatedCostUsd += event.costUsd;
      if (accumulatedCostUsd > approval.maxCostUsd) {
        deadline.abort(new Error("Provider 认证超过人工批准的费用上限"));
      }
    }
  };
}

function certificationUsage(durationMs) {
  const turns = certificationEvents.filter((event) => event.type === "turn_end");
  if (
    turns.length === 0 ||
    turns.some(
      (event) =>
        !Number.isInteger(event.inputTokens) ||
        event.inputTokens < 0 ||
        !Number.isInteger(event.outputTokens) ||
        event.outputTokens < 0 ||
        !Number.isFinite(event.costUsd) ||
        event.costUsd < 0,
    )
  ) {
    throw new Error("Provider 没有返回完整脱敏用量，认证停止");
  }
  const inputTokens = turns.reduce((total, event) => total + event.inputTokens, 0);
  const outputTokens = turns.reduce((total, event) => total + event.outputTokens, 0);
  return {
    providerCalls: certificationEvents.filter((event) => event.type === "provider_request").length,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: turns.reduce((total, event) => total + event.costUsd, 0),
    durationMs,
    retries: certificationEvents.filter(
      (event) => event.type === "retry" && event.scope === "provider",
    ).length,
  };
}

async function assertSecretsAbsent(directory, secrets) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await assertSecretsAbsent(target, secrets);
    else assertSecretsAbsentFromText(await readFile(target), secrets);
  }
}

function assertSecretsAbsentFromText(value, secrets) {
  const content = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  for (const secret of secrets.filter(Boolean)) {
    if (content.includes(Buffer.from(secret, "utf8"))) {
      throw new Error("Provider 认证临时 Fact 或证据包含凭据值");
    }
  }
}

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("没有找到 JSON 对象");
  return JSON.parse(match[0]);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}
