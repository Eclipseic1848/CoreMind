import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { checkInvariantFacts } from "./invariant-checker.js";
import { describeRaceScenario, generateRaceScenario, type RaceScenario } from "./race-seeds.js";
import type { RunStateRecord } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";

/**
 * 取消竞态种子矩阵验收套件（Issue #41 / 规格 04 门 C-1 + C-3）：
 * 1,000 个确定性种子场景（cancel/timeout/send/dispose × 流式/工具/审批/idle × 单次/多次），
 * 每种子断言四条：无迟到事实、无孤儿结果（I-7）、无重复副作用、无悬挂 Promise。
 * 失败种子输出 describeRaceScenario（含种子号）→ vitest -t "种子 N" 最小复现。
 * C-3：abort 后 50ms 完成流的迟到文本不入 transcript/会话树/trace（方案 A）。
 */

// ---------------------------------------------------------------------------
// 假 Provider：脚本化 SSE 响应 + 请求录制；脚本由当前场景闭包决定（串行执行安全）
// ---------------------------------------------------------------------------
const allRecorders = new Set<RequestRecorder>();

class RequestRecorder {
  private readonly recorded: unknown[][] = [];
  private consumed = 0;

  constructor() {
    allRecorders.add(this);
  }

  record(messages: unknown[]): void {
    this.recorded.push(messages);
  }

  take(index: number): unknown[] {
    const item = this.recorded[index];
    if (item === undefined) {
      throw new Error(`录制消费越界：请求 ${index} 不存在（共录制 ${this.recorded.length} 次）`);
    }
    this.consumed = Math.max(this.consumed, index + 1);
    return item;
  }

  count(): number {
    return this.recorded.length;
  }

  /** 等待录制数量超过 before（每种子场景的请求确认） */
  async waitForNext(before: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.recorded.length <= before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (this.recorded.length <= before) throw new Error("等待请求录制超时");
  }

  unconsumed(): number {
    return this.recorded.length - this.consumed;
  }
}

type MockScriptResult = Array<Record<string, unknown>>;

interface MockServerOptions {
  shouldRecord?: () => boolean;
  cancelReplyOnClose?: boolean;
}

/** 场景对应的响应脚本：流式文本或工具调用（timing 决定） */
function scenarioScript(scenario: RaceScenario, toolName: string): MockScriptResult {
  if (scenario.timing === "tool" || scenario.timing === "approval") {
    return [
      {
        id: "t",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${scenario.seed}`,
                  type: "function",
                  function: { name: toolName, arguments: '{"path":"notes.txt"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      { id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ];
  }
  return [
    {
      id: "a",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: `回答 ${scenario.seed}` },
          finish_reason: null,
        },
      ],
    },
    { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function createMockServer(
  getScript: () => MockScriptResult,
  recorder: RequestRecorder,
  getDelayMs: () => number,
  options: MockServerOptions = {},
): Promise<{
  server: Server;
  port: number;
  pendingReplies: () => number;
  replyAttempts: () => number;
}> {
  return new Promise((resolve) => {
    let pendingReplies = 0;
    let replyAttempts = 0;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages: unknown[] };
        if (options.shouldRecord?.() ?? true) recorder.record(parsed.messages);
        const script = getScript();
        const delayMs = getDelayMs();
        let replyPending = true;
        const settleReply = () => {
          if (!replyPending) return;
          replyPending = false;
          pendingReplies -= 1;
        };
        const reply = () => {
          replyAttempts += 1;
          settleReply();
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          for (const chunk of script) {
            response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
          response.write(
            `data: ${JSON.stringify({
              id: "usage",
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        };
        pendingReplies += 1;
        const timer = setTimeout(reply, delayMs);
        response.once("close", () => {
          if (options.cancelReplyOnClose === false) return;
          clearTimeout(timer);
          settleReply();
        });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: (server.address() as { port: number }).port,
        pendingReplies: () => pendingReplies,
        replyAttempts: () => replyAttempts,
      });
    });
  });
}

async function closeMockServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ---------------------------------------------------------------------------
// 场景执行与四条断言
// ---------------------------------------------------------------------------
interface SeedOutcome {
  result: Awaited<ReturnType<CoreMindRuntime["run"]>>;
  events: CoreMindEvent[];
  runtime: CoreMindRuntime;
}

interface SeedAssertions {
  /** abort/timeout 动作的触发时刻（种子场景内） */
  abortAt?: number;
  /** 触发时刻前已启动的 turnId 集合（R3：分界前启动的活动放行） */
  knownTurnIds: Set<string>;
}

/** 场景执行：建 runtime → 触发动作 → 等待 settle → 返回事件与结果 */
async function runSeedScenario(
  scenario: RaceScenario,
  recorder: RequestRecorder,
  port: number,
  dir: string,
  toolName: string,
  requestStartTimeoutMs = 15_000,
  timeoutStartupGraceMs = 0,
): Promise<SeedOutcome & SeedAssertions> {
  const events: CoreMindEvent[] = [];
  const controller = new AbortController();
  const isToolTiming = scenario.timing === "tool" || scenario.timing === "approval";
  const runtime = await CoreMindRuntime.create({
    config: {
      schemaVersion: 2,
      name: `竞态种子 ${scenario.seed}`,
      provider: {
        id: "probe",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "probe-model",
        apiKey: "test-key",
      },
      ...(isToolTiming ? { tools: [{ id: toolName }] } : {}),
      agents: { main: { systemPrompt: "助手" } },
      ...(scenario.timing === "approval" ? { permissions: { mode: "ask" } } : {}),
      ...(scenario.action === "timeout"
        ? {
            runtime: {
              runTimeoutMs: scenario.actionDelayMs + 80 + timeoutStartupGraceMs,
            },
          }
        : {}),
    },
    configDir: dir,
    cwd: dir,
    initialPrompt: `种子 ${scenario.seed}`,
    events: (event) => events.push(event),
    signal: controller.signal,
    // 审批挂起中：approveTool 永不 resolve（审批未决即触发动作）
    ...(scenario.timing === "approval" ? { approveTool: () => new Promise<never>(() => {}) } : {}),
  });

  const before = recorder.count();
  const runPromise = runtime.run();
  try {
    await Promise.race([
      recorder.waitForNext(before, requestStartTimeoutMs),
      runPromise.then(
        () => {
          if (recorder.count() <= before) {
            throw new Error("Run 在 Provider 请求录制前结束");
          }
        },
        (error: unknown) => Promise.reject(error),
      ),
    ]);
  } catch (error) {
    controller.abort();
    await withSeedTimeout(runPromise, scenario, requestStartTimeoutMs).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${describeRaceScenario(scenario)}：Provider 请求启动确认失败：${detail}`, {
      cause: error,
    });
  }

  const knownTurnIds = new Set(
    events.flatMap((event) => (event.type === "agent_start" && event.turnId ? [event.turnId] : [])),
  );

  // 动作触发（确定性延迟）；abortAt 用 Date.now()（与事件 timestamp 同一时间基准）。
  // send = "abort 后立即新输入"：先中止当前 run，再发起新 run（R4：不应污染新 run）
  const abortAt = Date.now();
  if (scenario.action !== "timeout") {
    await new Promise((resolve) => setTimeout(resolve, scenario.actionDelayMs));
    controller.abort();
    if (scenario.count === "multiple") {
      await new Promise((resolve) => setTimeout(resolve, scenario.secondActionDelayMs));
      controller.abort();
    }
  }
  const result = await withSeedTimeout(runPromise, scenario, 15_000);
  const outcome: SeedOutcome = { result, events, runtime };
  if (scenario.action === "send") {
    // 新输入：同一实例的新 run 必须无污染（无迟到事实、正常终态）
    const second = await CoreMindRuntime.create({
      config: {
        schemaVersion: 2,
        name: `竞态种子 ${scenario.seed} send`,
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "助手" } },
      },
      configDir: dir,
      cwd: dir,
      initialPrompt: `种子 ${scenario.seed} 新输入`,
      events: (event) => events.push(event),
    });
    await withSeedTimeout(second.run(), scenario, 15_000);
  }
  return { ...outcome, abortAt, knownTurnIds };
}

/** 断言 1：无迟到事实（准入拒绝仅来自 abort 机制自身收尾；trace 无分界点后新 turn 终态事件） */
function assertNoLateFacts(outcome: SeedOutcome & SeedAssertions, scenario: RaceScenario): void {
  const { result, events, abortAt, knownTurnIds } = outcome;
  // 准入计数：0 = 无迟到事实；abort/timeout 终态时 pi-agent 中止流程自身会发 failure
  // turn_end（stopReason aborted）被准入拒绝 → 计数 1 是机制正常工作的证据，不是旧活动迟到事实
  // abort/timeout 终态时 pi-agent 中止流程自身发 failure turn_end（1 次）；
  // tool 时机在飞工具的 tool_result 与原工具 Turn 的 turn_end 在 abort 后到达会被拒绝（再 +2）；
  // lifecycle reducer 会让该 Turn 保持开放直至 Call 收敛，因此这两个事实都可能晚于分界点。
  const abortedRun = result.outcome.status === "aborted" || result.outcome.status === "timeout";
  const maxRejected = abortedRun ? (scenario.timing === "tool" ? 3 : 1) : 0;
  const rejected = result.metrics.rejectedAfterAbort ?? 0; // 可选字段：0 时不落 metrics
  expect(
    rejected,
    `${describeRaceScenario(scenario)}：准入拒绝计数 ${rejected} 超过终态允许值 ${maxRejected}`,
  ).toBeLessThanOrEqual(maxRejected);
  if (abortAt === undefined || scenario.action === "send") return;
  // 分界点后到达的终态类事件（新 turn 归属）——已启动的 turn（R3）放行
  const lateTerminal = events.filter((event) => {
    if (event.timestamp === undefined) return false;
    if (Date.parse(event.timestamp) <= abortAt) return false;
    if (event.type === "turn_end" && event.turnId && !knownTurnIds.has(event.turnId)) return true;
    if (event.type === "tool_result" && event.turnId && !knownTurnIds.has(event.turnId))
      return true;
    return false;
  });
  expect(
    lateTerminal,
    `${describeRaceScenario(scenario)}：分界点后存在新 turn 的迟到终态事件`,
  ).toEqual([]);
}

/** 断言 2：无孤儿结果（I-7：每个工具 Call 有配对 tool_result 或 run 终态显式关闭） */
function assertNoOrphanCalls(outcome: SeedOutcome, scenario: RaceScenario): void {
  const { result } = outcome;
  const runRecords: RunStateRecord[] = [
    {
      version: 1,
      runId: result.runId,
      sequence: 1,
      timestamp: result.trace[0]?.timestamp ?? new Date(0).toISOString(),
      kind: "start",
      payload: {},
    },
    ...result.trace.map(
      (entry, index): RunStateRecord => ({
        version: 1,
        runId: result.runId,
        sequence: index + 2,
        timestamp: entry.timestamp,
        kind: "event",
        payload: entry,
      }),
    ),
    {
      version: 1,
      runId: result.runId,
      sequence: result.trace.length + 2,
      timestamp: new Date().toISOString(),
      kind: "finish",
      payload: { status: result.outcome.status },
    },
  ];
  const violations = checkInvariantFacts({ runRecords }, { mode: "gate" }).filter(
    (violation) => violation.invariant === "I-7",
  );
  expect(violations, `${describeRaceScenario(scenario)}：存在孤儿工具 Call`).toEqual([]);
}

/** 断言 3：无重复副作用（同 idempotencyKey 的 receipt 终态唯一） */
function assertNoDuplicateEffects(outcome: SeedOutcome, scenario: RaceScenario): void {
  const { events } = outcome;
  const terminalByKey = new Map<string, number>();
  for (const event of events) {
    if (event.type !== "effect_receipt") continue;
    if (event.status !== "committed" && event.status !== "unknown") continue;
    terminalByKey.set(event.idempotencyKey, (terminalByKey.get(event.idempotencyKey) ?? 0) + 1);
  }
  const duplicates = [...terminalByKey.entries()].filter(([, count]) => count > 1);
  expect(duplicates, `${describeRaceScenario(scenario)}：副作用 receipt 终态重复`).toEqual([]);
}

/** 执行一个种子范围块（共享 server，块内串行保持脚本闭包确定性） */
async function runSeedChunk(
  seedStart: number,
  seedEnd: number,
  toolName: string,
  serverOptions: MockServerOptions = {},
  requestStartTimeoutMs = 15_000,
): Promise<void> {
  const recorder = new RequestRecorder();
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-race-matrix-"));
  let currentScenario: RaceScenario = generateRaceScenario(seedStart);
  const { server, port } = await createMockServer(
    () => scenarioScript(currentScenario, toolName),
    recorder,
    () => (currentScenario.action === "timeout" ? currentScenario.actionDelayMs + 500 : 30),
    serverOptions,
  );
  try {
    for (let seed = seedStart; seed < seedEnd; seed += 1) {
      const scenario = generateRaceScenario(seed);
      currentScenario = scenario;
      const outcome = await runSeedScenario(
        scenario,
        recorder,
        port,
        dir,
        toolName,
        requestStartTimeoutMs,
      );
      assertNoLateFacts(outcome, scenario);
      assertNoOrphanCalls(outcome, scenario);
      assertNoDuplicateEffects(outcome, scenario);
      await assertNoHangingPromises(outcome, scenario, recorder);
      recorder.take(recorder.count() - 1);
    }
  } finally {
    // 断言失败时也消费全部录制（全局 afterEach 不因本测试的残留污染后续测试）
    if (recorder.count() > 0) recorder.take(recorder.count() - 1);
    await closeMockServer(server);
  }
}

/** 种子级超时保护：防止单个场景悬挂把整个矩阵卡死（悬挂即失败，回放契约） */
function withSeedTimeout<T>(
  promise: Promise<T>,
  scenario: RaceScenario,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `种子 ${scenario.seed} 超时（${timeoutMs}ms）——疑似悬挂 Promise\n${describeRaceScenario(scenario)}`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 断言 4：无悬挂 Promise（run 已 settle、无新事件、无未消费录制） */
async function assertNoHangingPromises(
  outcome: SeedOutcome,
  scenario: RaceScenario,
  recorder: RequestRecorder,
): Promise<void> {
  const eventCount = outcome.events.length;
  const recordedCount = recorder.count();
  // 收尾后的静默窗口：无新事件、无新请求
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(
    outcome.events.length,
    `${describeRaceScenario(scenario)}：run settle 后仍有新事件（悬挂活动）`,
  ).toBe(eventCount);
  expect(
    recorder.count(),
    `${describeRaceScenario(scenario)}：run settle 后仍有新请求（悬挂 Promise）`,
  ).toBe(recordedCount);
}

// ---------------------------------------------------------------------------
// 1,000 种子矩阵
// ---------------------------------------------------------------------------
describe("取消竞态种子矩阵（门 C-1，1,000 种子）", () => {
  it("Provider 请求启动确认失败时输出固定种子，支持回放", async () => {
    const scenario = generateRaceScenario(997);
    const recorder = new RequestRecorder();
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-race-replay-"));
    const { server, port } = await createMockServer(
      () => scenarioScript(scenario, "read"),
      recorder,
      () => 0,
      { shouldRecord: () => false },
    );
    try {
      await expect(runSeedScenario(scenario, recorder, port, dir, "read", 25)).rejects.toThrow(
        describeRaceScenario(scenario),
      );
    } finally {
      await closeMockServer(server);
    }
  });

  it("真实矩阵路径的请求启动失败保留固定种子", async () => {
    const scenario = generateRaceScenario(997);
    await expect(
      runSeedChunk(scenario.seed, scenario.seed + 1, "read", { shouldRecord: () => false }, 25),
    ).rejects.toThrow(describeRaceScenario(scenario));
  });

  it("Abort 后取消假 Provider 延迟回复，不跨种子悬挂", async () => {
    const scenario = generateRaceScenario(8);
    // 默认全量测试会跨文件并行；给本地 HTTP 请求建立连接留出独立宽限，
    // 同量推迟假回复，保持 timeout 仍比回复早 420ms，不弱化取消语义。
    const timeoutStartupGraceMs = 5_000;
    const recorder = new RequestRecorder();
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-race-provider-idle-"));
    const { server, port, pendingReplies } = await createMockServer(
      () => scenarioScript(scenario, "read"),
      recorder,
      () => scenario.actionDelayMs + 500 + timeoutStartupGraceMs,
    );
    try {
      await runSeedScenario(scenario, recorder, port, dir, "read", 15_000, timeoutStartupGraceMs);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pendingReplies(), describeRaceScenario(scenario)).toBe(0);
    } finally {
      if (recorder.count() > 0) recorder.take(recorder.count() - 1);
      await closeMockServer(server);
    }
  });

  it("全部种子通过四条断言；失败可回放（种子号）", async () => {
    const toolName = "read";
    // 种子范围（回放契约）：RACE_SEED_START/END 环境变量定位失败种子，
    // 默认全量 1,000（CI）。1000 种子串行约 10 分钟 → 4 块并行（每块独立
    // server/recorder/目录，块内串行保持脚本闭包确定性）压到 ~2-3 分钟
    const seedStart = Number(process.env.RACE_SEED_START ?? 0);
    const seedEnd = Number(process.env.RACE_SEED_END ?? 1_000);
    const CHUNKS = 4;
    const chunkSize = Math.ceil((seedEnd - seedStart) / CHUNKS);
    await Promise.all(
      Array.from({ length: CHUNKS }, (_, chunk) =>
        runSeedChunk(
          seedStart + chunk * chunkSize,
          Math.min(seedStart + (chunk + 1) * chunkSize, seedEnd),
          toolName,
        ),
      ),
    );
  }, 600_000);

  it("矩阵可复现：同种子产生相同场景（回放契约）", () => {
    for (let seed = 0; seed < 64; seed += 1) {
      expect(generateRaceScenario(seed)).toEqual(generateRaceScenario(seed));
    }
  });
});

// ---------------------------------------------------------------------------
// C-3：迟到回复拦截（abort 后 50ms 完成流）
// ---------------------------------------------------------------------------
describe("C-3 迟到回复拦截", () => {
  it("abort 后 50ms 完成的流式文本不入 transcript/会话树/trace（方案 A）", async () => {
    const recorder = new RequestRecorder();
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-race-c3-"));
    // abort 后 50ms 才完成流：请求录制后立即 abort，响应在 abort 生效后到达
    const { server, port, replyAttempts } = await createMockServer(
      () => [
        {
          id: "a",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "迟到的回答文本" },
              finish_reason: null,
            },
          ],
        },
        { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ],
      recorder,
      () => 50,
      { cancelReplyOnClose: false },
    );
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "C-3 迟到回复",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          agents: { main: { systemPrompt: "助手" } },
          session: { enabled: true },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "请回答",
        sessionId: "c3-session",
        events: (event) => events.push(event),
        signal: controller.signal,
      });
      const runPromise = runtime.run();
      await recorder.waitForNext(0);
      // 等 agent 开始流式等待（agent_start 已发出）再 abort，确保迟到窗口成立
      const deadline = Date.now() + 5_000;
      while (!events.some((event) => event.type === "agent_start") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      const result = await runPromise;
      expect(result.outcome.status).toBe("aborted");
      const replyDeadline = Date.now() + 1_000;
      while (replyAttempts() === 0 && Date.now() < replyDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(replyAttempts()).toBe(1);
      // transcript 无迟到文本（方案 A：竞态赢家文本丢弃）
      expect(result.transcript).not.toContain("迟到的回答文本");
      // trace 无迟到文本（turn_end 终态被准入拒绝或未落定）
      const turnEnds = events.filter((event) => event.type === "turn_end");
      expect(turnEnds).toEqual([]);
      const hasLateText = events.some(
        (event) => event.type === "text_delta" && event.delta.includes("迟到的回答文本"),
      );
      expect(hasLateText).toBe(false);
      // 会话树无迟到消息（persistSession 只写已确认部分）
      const sessionDir = path.join(dir, "sessions");
      const session = await CoreMindSession.open({
        dir: sessionDir,
        sessionId: "c3-session",
        cwd: dir,
      });
      const entries = await session.branchEntries();
      const texts = entries
        .filter((entry) => entry.type === "message")
        .map((entry) => JSON.stringify(entry.message));
      expect(texts.some((text) => text.includes("迟到的回答文本"))).toBe(false);
      recorder.take(0);
    } finally {
      recorder.take(recorder.count() - 1);
      await closeMockServer(server);
    }
  });
});

// ---------------------------------------------------------------------------
// 四入口取消路径覆盖（验收 AC-2）
// - TS SDK signal：本套件种子矩阵（cancel 场景）覆盖
// - CLI SIGINT：packages/coremind-cli 新增 SIGINT 取消测试（spawn + kill）
// - TUI /abort：packages/coremind-cli/src/tui.test.tsx 已有覆盖
// - worker cancel：packages/coremind-worker/src/server.test.ts 已有覆盖（含 D-1 首事件前）
// ---------------------------------------------------------------------------
describe("四入口取消路径", () => {
  it("TS SDK signal：runtime 层取消（种子矩阵 cancel 场景的代表）", async () => {
    const scenario = generateRaceScenario(0); // cancel × streaming × single
    const recorder = new RequestRecorder();
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-race-tsdk-"));
    const { server, port } = await createMockServer(
      () => scenarioScript(scenario, "read"),
      recorder,
      () => 200,
    );
    try {
      const outcome = await runSeedScenario(scenario, recorder, port, dir, "read");
      expect(outcome.result.outcome.status).toBe("aborted");
      recorder.take(recorder.count() - 1);
    } finally {
      recorder.take(recorder.count() - 1);
      await closeMockServer(server);
    }
  });
});

afterEach(() => {
  for (const recorder of allRecorders) {
    if (recorder.unconsumed() > 0) {
      throw new Error(`存在未消费的请求录制（${recorder.unconsumed()} 次）——测试未对齐`);
    }
  }
  allRecorders.clear();
});
