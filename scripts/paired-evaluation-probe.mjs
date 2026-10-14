import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const REQUEST_MS = 15_000;
const LIFECYCLE_MS = 30_000;
const DRAFT = "用户自己的未提交草稿，必须原样保留。\n";
const LATE_TEXT = "paired-late-text-must-not-be-committed";
const STREAM_CHUNKS = Array.from(
  { length: 64 },
  (_, index) => `${String(index).padStart(3, "0")}:${"x".repeat(2_043)}\n`,
);
const STREAM_TEXT = STREAM_CHUNKS.join("");
const metricNames = [
  "importMs",
  "cliVersionMs",
  "workerInitializeMs",
  "workerEofMs",
  "runtimeMs",
  "streamFastMs",
  "streamFastFirstDeltaMs",
  "streamSlowMs",
  "streamSlowFirstDeltaMs",
  "streamCancelAckMs",
  "streamCancelTerminalMs",
  "streamWarmMs",
  "streamWarmFirstDeltaMs",
  "inputTokens",
  "outputTokens",
  "costUsd",
  "providerTtftMs",
  "cacheSavingsUsd",
];
const emit = process.stdout.write.bind(process.stdout);
// SDK 的诊断也不能污染父进程读取的唯一 JSON 结果。
process.stdout.write = (...args) => process.stderr.write(...args);
const abort = new AbortController();
const onSignal = () => abort.abort();
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);

let input;
const report = {
  schemaVersion: 1,
  cellId: "unknown",
  caseId: "unknown",
  armId: "unknown",
  repetition: 0,
  status: "failed",
  qualityPassed: false,
  safetyPassed: false,
  metrics: Object.fromEntries(metricNames.map((name) => [name, null])),
  grading: {},
  evidence: {
    isolation: { home: homedir(), temp: tmpdir() },
    fixtureKind: "synthetic",
    protocol: {},
    unavailable: ["real-provider-ttft", "real-model-quality", "usage", "cost", "cache-savings"],
    timing: "单调时钟；runtimeMs 包含既有 suite/grader；新进程不代表 OS 冷缓存",
  },
  errors: [],
};

try {
  input = JSON.parse(await bounded(readInput(), REQUEST_MS, "读取探针输入"));
  const { cell, arm, fixtureRoot, workspace } = input;
  assert.equal(input.schemaVersion, 1);
  assert.ok(cell && ["typescript-defect", "python-defect"].includes(cell.caseId));
  assert.ok(typeof cell.id === "string" && cell.id && typeof cell.armId === "string" && cell.armId);
  assert.ok(Number.isInteger(cell.repetition) && cell.repetition > 0);
  Object.assign(report, {
    cellId: cell.id,
    caseId: cell.caseId,
    armId: cell.armId,
    repetition: cell.repetition,
  });
  for (const value of [
    arm.version,
    arm.sdkEntry,
    arm.cliEntry,
    arm.workerEntry,
    fixtureRoot,
    workspace,
  ]) {
    assert.equal(typeof value, "string");
    assert.ok(value.length > 0);
  }
  for (const value of [arm.sdkEntry, arm.cliEntry, arm.workerEntry, fixtureRoot, workspace]) {
    assert.ok(path.isAbsolute(value), "探针路径必须是父进程验证过的绝对路径");
  }
  assert.equal(readdirSync(workspace).length, 0, "每格必须使用新的空 workspace");
  process.env.CODING_MOCK_API_KEY = "paired-offline-synthetic";
  const project = path.join(workspace, "project");
  cpSync(path.join(fixtureRoot, cell.caseId), project, { recursive: true, dereference: true });
  for (const args of [
    ["init"],
    ["config", "user.email", "coremind@example.invalid"],
    ["config", "user.name", "CoreMind Eval"],
    ["add", "."],
    ["commit", "-m", "defect baseline"],
  ])
    git(project, ...args);
  writeFileSync(path.join(project, "user-notes.txt"), DRAFT, "utf8");
  report.evidence.initialDirtyStatus = git(project, "status", "--porcelain");

  const importedAt = performance.now();
  const sdk = await bounded(import(pathToFileURL(arm.sdkEntry).href), REQUEST_MS, "导入该臂 SDK");
  report.metrics.importMs = performance.now() - importedAt;
  for (const name of [
    "CoreMindRuntime",
    "runEvaluationSuite",
    "loadEvaluationSuite",
    "parseAndValidate",
    "ProjectionEngine",
  ]) {
    assert.ok(sdk[name], `该臂缺少公共 API：${name}`);
  }
  report.evidence.sdkEntry = realpathSync(arm.sdkEntry);
  const cli = startProcess(arm.cliEntry, ["--version"], workspace);
  try {
    const result = await bounded(cli.closed, REQUEST_MS, "CLI 轻入口启动");
    assert.equal(result.code, 0, cli.stderr());
    assert.equal(cli.stdout().trim(), `coremind v${arm.version}`);
    report.metrics.cliVersionMs = performance.now() - cli.startedAt;
    report.evidence.cli = {
      ...result,
      output: cli.stdout().trim(),
      scope: "--version 轻入口，未初始化 Runtime",
    };
  } finally {
    await cli.dispose();
  }

  const mockPath = path.join(fixtureRoot, "_shared", "mock-provider.mjs");
  const { createCodingEvalMockServer } = await import(pathToFileURL(mockPath).href);
  const coding = createCodingEvalMockServer(
    cell.caseId === "typescript-defect" ? "typescript" : "python",
  );
  let requestCount = 0;
  coding.on("request", () => requestCount++);
  await listen(coding);
  let runtime;
  try {
    const raw = await sdk.loadConfigFile(path.join(project, "coremind.yaml"));
    raw.provider = { ...raw.provider, baseUrl: address(coding), apiKeyEnv: "CODING_MOCK_API_KEY" };
    assert.equal(raw.quality?.profile, "development", "必须保留冻结夹具的 development 合同");
    const config = sdk.parseAndValidate(raw).config;
    const suite = await sdk.loadEvaluationSuite(path.join(project, "evals", "scenarios.yaml"));
    assert.equal(suite.scenarios.length, 1);
    assert.equal(suite.scenarios[0].repetitions, 1);
    let runtimeResult;
    const startedAt = performance.now();
    const evaluation = await bounded(
      sdk.runEvaluationSuite({
        config,
        configDir: project,
        cwd: project,
        suite,
        runtimeFactory: async (options) => {
          runtime = await sdk.CoreMindRuntime.create({ ...options, signal: abort.signal });
          return {
            run: async () => {
              runtimeResult = await runtime.run();
              return runtimeResult;
            },
          };
        },
      }),
      70_000,
      "单次 coding suite",
    );
    assert.equal(evaluation.totalRuns, 1);
    assert.equal(evaluation.attempts.length, 1);
    const attempt = evaluation.attempts[0];
    assert.equal(attempt.scenarioId, suite.scenarios[0].id);
    assert.equal(attempt.attempt, 1);
    report.grading.evaluation = evaluation;
    const safety = attempt.graderResults.filter((grader) => grader.id.startsWith("safety-"));
    report.qualityPassed = attempt.passed && evaluation.releaseReadiness.ready;
    report.safetyPassed =
      safety.length > 0 &&
      safety.every((grader) => grader.passed) &&
      runtimeResult?.evaluation.securityFindings.length === 0;
    if (report.qualityPassed) report.metrics.runtimeMs = performance.now() - startedAt;
    if (!report.qualityPassed || !report.safetyPassed)
      report.errors.push("既有 coding grader 未全部通过");
    assert.ok(runtime && (await bounded(runtime.waitForQuiescence(5_000), 6_000, "Runtime 静止")));
    assert.equal(readFileSync(path.join(project, "user-notes.txt"), "utf8"), DRAFT);
    report.evidence.coding = {
      mockSha256: sha(readFileSync(mockPath)),
      requests: requestCount,
      quiescent: true,
      finalDiff: git(project, "diff", "--no-ext-diff"),
      finalDirtyStatus: git(project, "status", "--porcelain"),
      synthetic: true,
      realUsage: null,
    };
  } catch (error) {
    abort.abort();
    if (runtime) {
      try {
        assert.ok(
          await bounded(runtime.waitForQuiescence(5_000), 6_000, "失败后 Runtime 静止", false),
        );
      } catch (cleanupError) {
        report.errors.push(`Runtime 清理失败：${cleanupError.message}`);
      }
    }
    throw error;
  } finally {
    await closeServer(coding);
  }

  const fixture = createStreamFixture();
  await listen(fixture.server);
  try {
    await withWorker("initialize", async (worker) => {
      report.metrics.workerInitializeMs = worker.initializeMs;
      report.metrics.workerEofMs = await worker.eof();
    });
    for (const mode of ["fast", "slow", "cancel", "warm"]) {
      await withWorker(mode, async (worker) => {
        if (mode === "warm")
          report.evidence.protocol.warmup = await streamRun(worker, "warmup", fixture, sdk);
        const result = await streamRun(worker, mode, fixture, sdk);
        report.evidence.protocol[mode].run = result;
        const title = `${mode[0].toUpperCase()}${mode.slice(1)}`;
        if (mode === "cancel") {
          report.metrics.streamCancelAckMs = result.cancelAckMs;
          report.metrics.streamCancelTerminalMs = result.cancelTerminalMs;
        } else {
          report.metrics[`stream${title}Ms`] = result.durationMs;
          report.metrics[`stream${title}FirstDeltaMs`] = result.firstDeltaMs;
        }
        await worker.eof();
      });
    }
  } finally {
    fixture.releaseLate();
    await closeServer(fixture.server);
  }
  report.grading.protocol = {
    passed: true,
    modes: ["initialize", "fast", "slow", "cancel", "warm"],
  };
  report.status =
    report.errors.length === 0 && report.qualityPassed && report.safetyPassed
      ? "succeeded"
      : "failed";

  async function withWorker(mode, check) {
    const directory = path.join(workspace, `worker-${mode}`);
    mkdirSync(directory);
    const evidence = { state: "starting", synthetic: true };
    evidence.sessionEnabled = mode === "cancel";
    if (mode === "warm") evidence.scope = "同一已预热 Worker 内的独立新 Run";
    report.evidence.protocol[mode] = evidence;
    const worker = createWorker(arm.workerEntry, directory, mode === "slow");
    try {
      const initialized = await worker.request("initialize", {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config: {
          schemaVersion: 2,
          name: "paired-stream-fixture",
          provider: {
            id: "paired-probe",
            model: "paired-fixture",
            baseUrl: address(fixture.server),
            apiKeyEnv: "CODING_MOCK_API_KEY",
          },
          agents: { main: {} },
          quality: { profile: "development" },
          runtime: { maxTurns: 2, maxRetries: 0, runTimeoutMs: LIFECYCLE_MS },
          session: { enabled: mode === "cancel", dir: "sessions", compact: false },
        },
        configDir: directory,
        cwd: directory,
        sessionId: `paired-${mode}`,
      });
      assert.equal(initialized.selectedProtocol, "2.0");
      assert.equal(initialized.runtime, "node");
      assert.equal(initialized.schemaFingerprint, sdk.PROTOCOL_V2_SCHEMA_FINGERPRINT);
      worker.initializeMs = performance.now() - worker.startedAt;
      evidence.initializeMs = worker.initializeMs;
      evidence.schemaFingerprint = initialized.schemaFingerprint;
      await check(worker);
      evidence.state = "closed";
      evidence.exit = await worker.closed;
      evidence.eofMs = worker.eofMs;
      evidence.shutdownQuiescent = null;
      evidence.stdoutBytes = worker.bytes();
      evidence.slowConsumer = worker.slowEvidence;
    } finally {
      evidence.cleanup = await worker.dispose();
    }
  }
} catch (error) {
  abort.abort();
  report.qualityPassed = false;
  report.safetyPassed = false;
  report.errors.push(error instanceof Error ? error.message : String(error));
} finally {
  process.stdin.destroy();
  process.removeListener("SIGTERM", onSignal);
  process.removeListener("SIGINT", onSignal);
  emit(`${JSON.stringify(report)}\n`, "utf8");
  if (report.status !== "succeeded") process.exitCode = 1;
}

async function streamRun(worker, mode, fixture, sdk) {
  const runId = `paired-${mode}`;
  const startedAt = performance.now();
  const handle = await worker.request("run", { runId, input: `paired-${mode}` });
  assert.equal(handle.runId, runId);
  await bounded(
    waitUntil(() => worker.live.get(runId)?.firstDeltaAt !== undefined),
    LIFECYCLE_MS,
    `${mode} 首文本事件`,
  );
  const live = worker.live.get(runId);
  let cancelledAt;
  let receipt;
  let cancelAckMs = null;
  if (mode === "cancel") {
    assert.equal(fixture.stats.get(mode)?.finishSent, false);
    cancelledAt = performance.now();
    receipt = await worker.request("control", {
      schemaVersion: 1,
      controlId: "paired-cancel-control",
      runId,
      type: "cancel",
    });
    cancelAckMs = performance.now() - cancelledAt;
    assert.equal(receipt.status, "applied");
    fixture.releaseLate();
  }
  let query;
  await bounded(
    (async () => {
      while (!query?.projection?.outcome) {
        query = await worker.request("query", { runId });
        if (!query.projection?.outcome) await delay(20);
      }
    })(),
    LIFECYCLE_MS,
    `${mode} 终态`,
  );
  const terminalAt = performance.now();
  const projection = query.projection;
  assert.equal(projection.outcome.status, mode === "cancel" ? "aborted" : "succeeded");
  assert.ok(!projection.trace.some((entry) => entry.event.type === "quiescence_timeout"));
  const rebuilt = sdk.ProjectionEngine.project(projection.records);
  assert.deepEqual(rebuilt.outcome, projection.outcome);
  let cursor = 0;
  let hasMore = true;
  const replay = [];
  while (hasMore) {
    const page = await worker.request("events", { runId, afterSequence: cursor, limit: 100 });
    assert.equal(page.runId, runId);
    assert.equal(page.afterSequence, cursor);
    assert.ok(page.nextCursor >= cursor && (!page.hasMore || page.nextCursor > cursor));
    replay.push(...page.events);
    cursor = page.nextCursor;
    hasMore = page.hasMore;
  }
  assert.equal(cursor, query.derivedFromSequence);
  assert.equal(replay.length, projection.records.length);
  assert.equal(new Set(replay.map((event) => event.sequence)).size, replay.length);
  const text = replay
    .filter((event) => event.eventType === "text_delta")
    .map((event) => event.payload.delta)
    .join("");
  const projectionText = rebuilt.trace
    .filter((entry) => entry.event.type === "text_delta")
    .map((entry) => entry.event.delta)
    .join("");
  assert.equal(text, projectionText);
  if (mode === "cancel") {
    assert.ok(!JSON.stringify(projection).includes(LATE_TEXT));
    await bounded(
      waitUntil(
        () => fixture.stats.get(mode)?.lateAttempted && fixture.stats.get(mode)?.connectionClosed,
      ),
      REQUEST_MS,
      "取消后连接结束与迟到文本尝试",
    );
    const sessionFiles = readdirSync(path.join(worker.directory, "sessions"), {
      recursive: true,
      withFileTypes: true,
      encoding: "utf8",
    }).filter((entry) => entry.isFile());
    assert.ok(sessionFiles.length > 0, "取消后的真实会话文件必须存在");
    for (const file of sessionFiles) {
      assert.ok(!readFileSync(path.join(file.parentPath, file.name), "utf8").includes(LATE_TEXT));
    }
  } else {
    assert.equal(text, STREAM_TEXT);
    assert.equal(fixture.stats.get(mode)?.requests, 1);
    assert.equal(fixture.stats.get(mode)?.finishSent, true);
  }
  return {
    outcome: projection.outcome,
    durationMs: terminalAt - startedAt,
    firstDeltaMs: live.firstDeltaAt - startedAt,
    cancelAckMs,
    cancelTerminalMs: cancelledAt === undefined ? null : terminalAt - cancelledAt,
    controlReceipt: receipt ?? null,
    replayCount: replay.length,
    replayCursor: cursor,
    replaySha256: sha(JSON.stringify(replay)),
    textSha256: sha(text),
    textBytes: Buffer.byteLength(text),
    liveCount: live.count,
    liveTextBytes: live.textBytes,
    noQuiescenceTimeout: true,
    rebuiltOutcome: rebuilt.outcome,
    fixture: fixture.stats.get(mode),
    synthetic: true,
  };
}

function createWorker(entry, directory, slow) {
  const process = startProcess(entry, [], directory, false);
  const decoder = new StringDecoder("utf8");
  const pending = new Map();
  const live = new Map();
  let buffer = "";
  let nextId = 0;
  let failure;
  let eofMs;
  let interval;
  let restoreTimer;
  const slowEvidence = {
    boundary: "真实 Worker stdout；不代表 Provider 逐级背压",
    throttled: false,
    quotaBytes: 4_096,
    intervalMs: 20,
    durationMs: 350,
    limitedReads: 0,
  };
  const fail = (error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  const consume = (chunk) => {
    try {
      process.count(chunk);
      buffer += decoder.write(chunk);
      assert.ok(Buffer.byteLength(buffer) < 16 * 1024 * 1024, "Worker JSON 行过大");
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        assert.equal(message.jsonrpc, "2.0");
        if (message.method === "event") {
          const params = message.params;
          const info = live.get(params.runId) ?? { count: 0, textBytes: 0 };
          live.set(params.runId, info);
          info.count++;
          if (params.event.type === "text_delta") {
            info.textBytes += Buffer.byteLength(params.event.delta);
            if (!params.event.delta) continue;
            info.firstDeltaAt ??= performance.now();
            if (slow && !slowEvidence.throttled) {
              slowEvidence.throttled = true;
              process.child.stdout.pause();
              process.child.stdout.removeListener("data", consume);
              interval = setInterval(() => {
                const bytes = process.child.stdout.read(slowEvidence.quotaBytes);
                if (bytes) {
                  slowEvidence.limitedReads++;
                  consume(bytes);
                }
              }, slowEvidence.intervalMs);
              restoreTimer = setTimeout(restore, slowEvidence.durationMs);
            }
          }
        } else if (Object.hasOwn(message, "id")) {
          const waiting = pending.get(String(message.id));
          assert.ok(waiting, "Worker 返回未请求或重复的响应");
          pending.delete(String(message.id));
          if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
          else waiting.resolve(message.result);
        } else throw new Error(`未知 Worker 通知：${message.method}`);
      }
    } catch (error) {
      fail(error);
    }
  };
  const restore = () => {
    clearInterval(interval);
    clearTimeout(restoreTimer);
    if (!process.child.stdout.listeners("data").includes(consume))
      process.child.stdout.on("data", consume);
    process.child.stdout.resume();
  };
  process.child.stdout.on("data", consume);
  process.closed.then(() => fail(new Error("Worker 已关闭")), fail);
  return {
    ...process,
    directory,
    live,
    slowEvidence,
    get eofMs() {
      return eofMs;
    },
    async request(method, params) {
      if (failure) throw failure;
      const id = String(++nextId);
      const message = {
        jsonrpc: "2.0",
        ...(method === "initialize" ? {} : { protocolVersion: "2.0" }),
        id,
        method,
        params,
      };
      const reply = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        process.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
          if (error) reject(error);
        });
      });
      try {
        return await bounded(reply, REQUEST_MS, `Worker ${method}`);
      } finally {
        pending.delete(id);
      }
    },
    async eof() {
      restore();
      const at = performance.now();
      process.child.stdin.end();
      const result = await bounded(process.closed, LIFECYCLE_MS, "Worker EOF 退出");
      assert.equal(result.code, 0, process.stderr());
      assert.equal(result.signal, null);
      assert.equal((buffer + decoder.end()).trim(), "");
      if (failure && failure.message !== "Worker 已关闭") throw failure;
      eofMs = performance.now() - at;
      return eofMs;
    },
    async dispose() {
      restore();
      return process.dispose();
    },
  };
}

function startProcess(entry, args, cwd, collect = true) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let output = "";
  let diagnostic = "";
  let bytes = 0;
  let settled = false;
  let failure;
  const count = (chunk) => {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) {
      failure ??= new Error("Worker 输出超过 32MiB");
      child.kill();
    }
  };
  if (collect)
    child.stdout.on("data", (chunk) => {
      count(chunk);
      output += chunk.toString("utf8");
    });
  child.stderr.on("data", (chunk) => {
    count(chunk);
    if (Buffer.byteLength(diagnostic) < 1024 * 1024) diagnostic += chunk.toString("utf8");
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      if (failure) reject(failure);
      else resolve({ code, signal });
    });
  });
  closed.catch(() => {});
  return {
    child,
    closed,
    count,
    startedAt,
    stdout: () => output,
    stderr: () => diagnostic,
    bytes: () => bytes,
    async dispose() {
      if (settled) return { forced: false };
      child.stdin.end();
      if (await stoppedSoon()) return { forced: false };
      if (process.platform === "win32") child.kill("SIGTERM");
      else {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
      if (await stoppedSoon()) return { forced: true };
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          encoding: "utf8",
          timeout: 5_000,
          windowsHide: true,
          stdio: "pipe",
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await bounded(
        closed.catch(() => {}),
        5_000,
        "回收自有进程",
        false,
      );
      return { forced: true };
      async function stoppedSoon() {
        return Promise.race([
          closed.then(
            () => true,
            () => true,
          ),
          delay(500).then(() => false),
        ]);
      }
    },
  };
}

function createStreamFixture() {
  const stats = new Map();
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const server = createServer((request, response) => {
    void serve().catch(() => response.destroy());
    async function serve() {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      let body = "";
      for await (const chunk of request) {
        body += chunk.toString("utf8");
        assert.ok(Buffer.byteLength(body) < 1024 * 1024);
      }
      const parsed = JSON.parse(body);
      const prompt = JSON.stringify(parsed.messages.at(-1).content);
      const mode = ["fast", "slow", "cancel", "warmup", "warm"].find((value) =>
        prompt.includes(`paired-${value}`),
      );
      assert.ok(mode);
      const state = stats.get(mode) ?? {
        requests: 0,
        finishSent: false,
        lateAttempted: false,
        connectionClosed: false,
        chunks: 0,
        textBytes: 0,
      };
      stats.set(mode, state);
      state.requests++;
      response.once("close", () => {
        state.connectionClosed = true;
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const texts = mode === "cancel" ? STREAM_CHUNKS.slice(0, 5) : STREAM_CHUNKS;
      for (const content of texts) {
        if (response.destroyed) return;
        const writable = response.write(
          `data: ${JSON.stringify({ id: "paired-fixed", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
        );
        state.chunks++;
        state.textBytes += Buffer.byteLength(content);
        if (!writable)
          await bounded(
            Promise.race([once(response, "drain"), once(response, "close")]),
            REQUEST_MS,
            "fixture drain",
          );
        await delay(1);
      }
      if (mode === "cancel") {
        await late;
        state.lateAttempted = true;
        if (response.destroyed) return;
        response.write(
          `data: ${JSON.stringify({ id: "paired-fixed", choices: [{ index: 0, delta: { content: LATE_TEXT }, finish_reason: null }] })}\n\n`,
        );
      }
      if (response.destroyed) return;
      state.finishSent = true;
      response.write(
        `data: ${JSON.stringify({ id: "paired-fixed", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    }
  });
  return { server, stats, releaseLate: () => release() };
}

async function readInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    assert.ok(Buffer.byteLength(text) <= 64 * 1024, "探针输入过大");
  }
  return text;
}

async function bounded(promise, timeoutMs, label, cancellable = true) {
  let timer;
  let cancel;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
      }),
      new Promise((_, reject) => {
        cancel = () => reject(new Error(`${label} 已取消`));
        if (!cancellable) return;
        if (abort.signal.aborted) cancel();
        else abort.signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    abort.signal.removeEventListener("abort", cancel);
  }
}

async function waitUntil(check) {
  while (!check()) {
    if (abort.signal.aborted) throw new Error("探针已取消");
    await delay(10);
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await bounded(once(server, "listening"), REQUEST_MS, "本地 fixture 启动");
}

function address(server) {
  return `http://127.0.0.1:${server.address().port}/v1`;
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
function git(cwd, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    timeout: REQUEST_MS,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
