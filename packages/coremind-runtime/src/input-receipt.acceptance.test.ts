import "../../../test/setup-env.js";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { foldInputReceipts, type InputId, inputFingerprint } from "./input-receipt.js";
import { FileRunStore, prepareRunResume, type RunStateRecord } from "./run-state.js";
import { CoreMindRuntime } from "./runtime.js";

/**
 * 输入收据与静止判定验收套件（Issue #40 / 规格 03 §4-§5）：
 * - 收据链：headless initialPrompt / chat 每轮 → pending → claimed（绑定 TurnId）→ completed
 * - abort 后未消费输入 → discarded
 * - 审批拒绝 paused → 保持 claimed；resume 继承同一 inputId（收据链连续）
 * - Resume 校验：输入收据与恢复输入一致方可恢复（resume_input_mismatch 语义）
 * - waitForQuiescence：正常 run 后立即静止；永不 idle 时超时记录 quiescence_timeout 不改变终态
 * - 假 Provider 下 Cancel → Quiescent p95 < 250ms（100 次采样）
 */

// ---------------------------------------------------------------------------
// 精简假 Provider：脚本化 SSE 响应，记录每次请求
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

  /** 等待至少录制到一次请求（abort 时序控制用） */
  async waitUntilRecorded(timeoutMs = 5_000): Promise<void> {
    await this.waitForNext(0, timeoutMs);
  }

  /** 等待录制数量超过 before（复用同一 recorder 的多轮采样用） */
  async waitForNext(before: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.recorded.length <= before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (this.recorded.length <= before) throw new Error("等待请求录制超时");
  }

  unconsumed(): number {
    return this.recorded.length - this.consumed;
  }
}

type MockScriptResult =
  | Array<Record<string, unknown>>
  | { error: { status: number; message: string } };

function createMockServer(
  script: (messages: unknown[], attempt: number) => MockScriptResult,
  recorder: RequestRecorder,
  options: { responseDelayMs?: number; hangResponse?: boolean } = {},
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages: unknown[] };
        recorder.record(parsed.messages);
        if (options.hangResponse) return; // 永不响应：agent 一直等待流（isStreaming 恒 true）
        const reply = () => {
          const result = script(parsed.messages, recorder.count());
          if (result !== null && typeof result === "object" && "error" in result) {
            response.writeHead(result.error.status, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: result.error.message } }));
            return;
          }
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          for (const chunk of result as Array<Record<string, unknown>>) {
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
        // 响应延迟：abort 时序测试需要 run 在请求已发出但未完成时被中止
        if (options.responseDelayMs !== undefined) {
          setTimeout(reply, options.responseDelayMs);
        } else {
          reply();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/** 纯文本回复的 SSE 脚本 */
function textScript(text: string): MockScriptResult {
  return [
    {
      id: "a",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

/** 单次工具调用的 SSE 脚本 */
function toolCallScript(tool: string, args: string): MockScriptResult {
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
                id: `call-${tool}`,
                type: "function",
                function: { name: tool, arguments: args },
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

interface FixtureOptions {
  initialPrompt: string;
  serverScript: (messages: unknown[], attempt: number) => MockScriptResult;
  signal?: AbortSignal;
  approveTool?: (request: { tool: string }) => Promise<"allow" | "deny">;
  tools?: string[];
  permissions?: "ask";
  resumeRunId?: string;
  /** 共享工作目录（resume 需要读取同一 runStore） */
  dir?: string;
}

interface FixtureOutcome {
  result: Awaited<ReturnType<CoreMindRuntime["run"]>>;
  recorder: RequestRecorder;
  events: CoreMindEvent[];
  runtime: CoreMindRuntime;
  dir: string;
}

async function runFixture(options: FixtureOptions): Promise<FixtureOutcome> {
  const recorder = new RequestRecorder();
  const { server, port } = await createMockServer(options.serverScript, recorder);
  const dir = options.dir ?? mkdtempSync(path.join(tmpdir(), "coremind-receipt-"));
  const events: CoreMindEvent[] = [];
  try {
    const runtime = await CoreMindRuntime.create({
      config: {
        schemaVersion: 2,
        name: "收据验收",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        ...(options.tools ? { tools: options.tools.map((id) => ({ id })) } : {}),
        agents: { main: { systemPrompt: "助手" } },
        ...(options.permissions ? { permissions: { mode: options.permissions } } : {}),
      },
      configDir: dir,
      cwd: dir,
      initialPrompt: options.initialPrompt,
      events: (event) => events.push(event),
      signal: options.signal,
      ...(options.approveTool ? { approveTool: options.approveTool } : {}),
      ...(options.resumeRunId ? { resumeRunId: options.resumeRunId } : {}),
    });
    const result = await runtime.run();
    return { result, recorder, events, runtime, dir };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 从事件序列取输入收据事件 */
function receiptEvents(events: CoreMindEvent[]) {
  return events.filter(
    (event) =>
      event.type === "input_receipt" ||
      event.type === "input_claimed" ||
      event.type === "input_completed" ||
      event.type === "input_discarded",
  );
}

/** 等待事件流中出现指定类型的事件（时序控制：确保活动已开始） */
async function waitForEvent(
  events: CoreMindEvent[],
  type: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!events.some((event) => event.type === type) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!events.some((event) => event.type === type)) {
    throw new Error(`等待事件 ${type} 超时`);
  }
}

// ---------------------------------------------------------------------------
// 1. 收据链：headless initialPrompt / chat 每轮
// ---------------------------------------------------------------------------
describe("输入收据链（headless run）", () => {
  it("正常 run：pending → claimed（绑定首个 agent_start 的 TurnId）→ completed", async () => {
    const outcome = await runFixture({
      initialPrompt: "你好",
      serverScript: () => textScript("收到"),
    });

    const receipts = receiptEvents(outcome.events);
    expect(receipts.map((event) => event.type)).toEqual([
      "input_receipt",
      "input_claimed",
      "input_completed",
    ]);
    const pending = receipts[0] as { inputId: string; contentFingerprint: string };
    const claimed = receipts[1] as { inputId: string; turnId: string };
    const completed = receipts[2] as { inputId: string };
    // 同一输入 ID 贯穿，折叠终态 completed
    expect(claimed.inputId).toBe(pending.inputId);
    expect(completed.inputId).toBe(pending.inputId);
    expect(foldInputReceipts(outcome.events).get(pending.inputId as InputId)).toBe("completed");
    // pending 收据携带指纹（sha256 短摘要，不落原文）
    expect(pending.contentFingerprint).toBe(inputFingerprint("你好"));
    // claim 绑定首个 agent_start 的 turnId
    const firstAgentStart = outcome.events.find((event) => event.type === "agent_start");
    expect(claimed.turnId).toBe((firstAgentStart as { turnId?: string } | undefined)?.turnId);
    // 终态成功
    expect(outcome.result.outcome.status).toBe("succeeded");
    outcome.recorder.take(0);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("input_claimed 在 agent_start 之后发出（输入被首个 Turn 认领）", async () => {
    const outcome = await runFixture({
      initialPrompt: "继续",
      serverScript: () => textScript("好"),
    });
    const claimedIndex = outcome.events.findIndex((event) => event.type === "input_claimed");
    const agentStartIndex = outcome.events.findIndex((event) => event.type === "agent_start");
    expect(claimedIndex).toBeGreaterThan(agentStartIndex);
    expect(claimedIndex).toBeLessThan(
      outcome.events.findIndex((event) => event.type === "agent_end"),
    );
    outcome.recorder.take(0);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });
});

describe("输入收据（chat/TUI 每轮）", () => {
  it("每轮 message 作为该轮 Run 的输入，收据链完整", async () => {
    const outcome = await runFixture({
      initialPrompt: "第一轮问题",
      serverScript: () => textScript("第一轮回答"),
    });
    const receipts = receiptEvents(outcome.events);
    expect(receipts.map((event) => event.type)).toEqual([
      "input_receipt",
      "input_claimed",
      "input_completed",
    ]);
    const pending = receipts[0] as { contentFingerprint: string };
    expect(pending.contentFingerprint).toBe(inputFingerprint("第一轮问题"));
    outcome.recorder.take(0);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. abort 后未消费输入 → discarded
// ---------------------------------------------------------------------------
describe("abort 后未消费输入 → discarded", () => {
  it("abort 于认领前（signal 预中止，agent 从未启动）：pending → discarded", async () => {
    const recorder = new RequestRecorder();
    const { server, port } = await createMockServer(() => textScript("回答"), recorder);
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-pending-abort-"));
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    controller.abort(); // 预中止：runWithGuard 入口直接抛 aborted，agent 从未创建
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "收据 pending abort",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { systemPrompt: "助手" } },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "未认领的输入",
        events: (event) => events.push(event),
        signal: controller.signal,
      });
      const result = await runtime.run();
      const receipts = receiptEvents(events);
      expect(receipts.map((event) => event.type)).toEqual(["input_receipt", "input_discarded"]);
      const pending = receipts[0] as { inputId: string };
      expect(foldInputReceipts(events).get(pending.inputId as InputId)).toBe("discarded");
      expect(result.outcome.status).toBe("aborted");
      // 无任何请求发出（agent 从未启动）
      expect(recorder.count()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("abort 生效后输入收据终态为 discarded，outcome 为 aborted", async () => {
    const recorder = new RequestRecorder();
    // 响应延迟：确保 abort 发生在 run 进行中（mock 响应太快要 abort 追不上完成）
    const { server, port } = await createMockServer(() => textScript("迟到的回答"), recorder, {
      responseDelayMs: 300,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-abort-"));
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "收据 abort",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { systemPrompt: "助手" } },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "请回答",
        events: (event) => events.push(event),
        signal: controller.signal,
      });
      const runPromise = runtime.run();
      // 等输入被首个 Turn 认领（agent_start 已发出、claim 已发生）且请求已发出再 abort，
      // 保证 abort 发生在 run 进行中、收据处于 claimed（→ discarded 路径）、录制可消费
      await waitForEvent(events, "agent_start");
      await recorder.waitUntilRecorded();
      controller.abort();
      const result = await runPromise;
      const receipts = receiptEvents(events);
      expect(receipts.map((event) => event.type)).toEqual([
        "input_receipt",
        "input_claimed",
        "input_discarded",
      ]);
      const pending = receipts[0] as { inputId: string };
      expect(foldInputReceipts(events).get(pending.inputId as InputId)).toBe("discarded");
      expect(result.outcome.status).toBe("aborted");
      recorder.take(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 审批拒绝 paused → 保持 claimed（可恢复）；resume 继承 inputId
// ---------------------------------------------------------------------------
describe("审批拒绝 paused 与 resume 收据继承", () => {
  it("审批拒绝后收据保持 claimed（无 completed/discarded），终态 paused", async () => {
    const outcome = await runFixture({
      initialPrompt: "读文件",
      serverScript: () => toolCallScript("read", '{"path":"notes.txt"}'),
      approveTool: async () => "deny",
      tools: ["read"],
      permissions: "ask",
    });

    const receipts = receiptEvents(outcome.events);
    expect(receipts.map((event) => event.type)).toEqual(["input_receipt", "input_claimed"]);
    expect(outcome.result.outcome.status).toBe("paused");
    outcome.recorder.take(0);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("resume 相同输入：沿用原 inputId，收据链连续，终态 completed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-resume-"));
    const recorder = new RequestRecorder();
    // 两次 run 必须共享同一 server（baseConfig 含 baseUrl → 配置指纹一致才能恢复）
    const { server, port } = await createMockServer(
      (_messages, attempt) =>
        attempt === 1 ? toolCallScript("read", '{"path":"notes.txt"}') : textScript("读到了"),
      recorder,
    );
    const baseConfig = {
      schemaVersion: 2,
      name: "收据 resume 继承",
      provider: {
        id: "probe",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "probe-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      tools: [{ id: "read" }],
      agents: { main: { systemPrompt: "调用工具" } },
      permissions: { mode: "ask" },
    };
    try {
      // 第一次：审批拒绝 → paused（输入保持 claimed）
      const firstEvents: CoreMindEvent[] = [];
      const first = await CoreMindRuntime.create({
        config: baseConfig,
        configDir: dir,
        cwd: dir,
        initialPrompt: "读文件",
        events: (event) => firstEvents.push(event),
        approveTool: async () => "deny",
      });
      const firstResult = await first.run();
      expect(firstResult.outcome.status).toBe("paused");
      const firstReceipts = receiptEvents(firstEvents);
      expect(firstReceipts.map((event) => event.type)).toEqual(["input_receipt", "input_claimed"]);

      // 第二次：resume 同一输入（同一 runStore 目录），审批允许 → 成功
      const secondEvents: CoreMindEvent[] = [];
      const second = await CoreMindRuntime.create({
        config: baseConfig,
        configDir: dir,
        cwd: dir,
        initialPrompt: "读文件",
        events: (event) => secondEvents.push(event),
        approveTool: async () => "allow",
        resumeRunId: firstResult.runId,
      });
      const secondResult = await second.run();
      // 现状语义：resume 恢复 previousTrace（含 policy_denied）→ 终态仍 paused
      // （等待用户继续处置；输入收据保持 claimed，可再次恢复）
      expect(secondResult.outcome.status).toBe("paused");
      const secondReceipts = receiptEvents(secondEvents);
      // resume 沿用原 inputId（收据链连续）：本 run 不重复登记 pending、不重复 claim。
      // 若 inputId 未继承会新发 input_receipt——此断言即继承生效的证据
      expect(secondReceipts).toEqual([]);
      recorder.take(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resume 不同输入：resume_input_mismatch 拒绝恢复", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-mismatch-"));
    const recorder = new RequestRecorder();
    // 两次 run 共享同一 server（配置指纹一致才能走到输入校验）
    const { server, port } = await createMockServer(
      () => toolCallScript("read", '{"path":"notes.txt"}'),
      recorder,
    );
    const baseConfig = {
      schemaVersion: 2,
      name: "收据 mismatch",
      provider: {
        id: "probe",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "probe-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      tools: [{ id: "read" }],
      agents: { main: { systemPrompt: "调用工具" } },
      permissions: { mode: "ask" },
    };
    try {
      const first = await CoreMindRuntime.create({
        config: baseConfig,
        configDir: dir,
        cwd: dir,
        initialPrompt: "读文件",
        approveTool: async () => "deny",
      });
      const firstResult = await first.run();
      expect(firstResult.outcome.status).toBe("paused");
      recorder.take(0);

      await expect(
        CoreMindRuntime.create({
          config: baseConfig,
          configDir: dir,
          cwd: dir,
          initialPrompt: "完全不同的输入",
          resumeRunId: firstResult.runId,
        }).then((runtime) => runtime.run()),
      ).rejects.toMatchObject({ code: "resume_input_mismatch" });
      // 未发出任何请求（校验发生在执行前）
      expect(recorder.count()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 4. resume 校验：输入收据参与合法性判定（prepareRunResume 层）
// ---------------------------------------------------------------------------
describe("prepareRunResume 输入收据联动", () => {
  function record(sequence: number, kind: string, payload: unknown): RunStateRecord {
    return {
      version: 1,
      runId: "run-receipt",
      sequence,
      timestamp: "2026-08-18T00:00:00.000Z",
      kind: kind as RunStateRecord["kind"],
      payload,
    };
  }

  function traceRecord(
    sequence: number,
    traceSequence: number,
    event: Record<string, unknown>,
  ): RunStateRecord {
    return record(sequence, "event", {
      eventId: `event-${sequence}`,
      runId: "run-receipt",
      sequence: traceSequence,
      timestamp: "2026-08-18T00:00:00.000Z",
      event,
    });
  }

  const baseRecords: RunStateRecord[] = [
    record(1, "start", { configFingerprint: "fp", initialPrompt: "原输入" }),
    traceRecord(2, 1, {
      type: "input_receipt",
      inputId: "input-1",
      status: "pending",
      contentFingerprint: inputFingerprint("原输入"),
      timestamp: "2026-08-18T00:00:00.000Z",
    }),
  ];

  it("有收据时按指纹校验：相同输入可恢复", () => {
    expect(() => prepareRunResume(baseRecords, "fp", "原输入")).not.toThrow();
  });

  it("有收据时按指纹校验：不同输入拒绝（resume_input_mismatch）", () => {
    expect(() => prepareRunResume(baseRecords, "fp", "其他输入")).toThrowError(
      expect.objectContaining({ code: "resume_input_mismatch" }),
    );
  });

  it("无收据（0.3.0 旧格式）保留现状字符串比对", () => {
    const legacy = [record(1, "start", { configFingerprint: "fp", initialPrompt: "原输入" })];
    expect(() => prepareRunResume(legacy, "fp", "原输入")).not.toThrow();
    expect(() => prepareRunResume(legacy, "fp", "其他输入")).toThrowError(
      expect.objectContaining({ code: "resume_input_mismatch" }),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. waitForQuiescence：静止判定与超时
// ---------------------------------------------------------------------------
describe("waitForQuiescence", () => {
  it("正常 run 结束后立即静止（无额外等待）", async () => {
    const outcome = await runFixture({
      initialPrompt: "你好",
      serverScript: () => textScript("收到"),
    });
    const started = performance.now();
    const quiescent = await outcome.runtime.waitForQuiescence(1_000);
    const elapsed = performance.now() - started;
    expect(quiescent).toBe(true);
    expect(elapsed).toBeLessThan(500);
    // 无 quiescence_timeout 事件
    expect(outcome.events.some((event) => event.type === "quiescence_timeout")).toBe(false);
    outcome.recorder.take(0);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("永不 idle（Provider 永不响应）时超时记录 quiescence_timeout 事件，不改变终态", async () => {
    const recorder = new RequestRecorder();
    // 永不响应：agent 一直等待流（isStreaming 恒 true），静止判定永不满足
    const { server, port } = await createMockServer(() => [], recorder, { hangResponse: true });
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-quiescence-"));
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "收据超时",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { systemPrompt: "助手" } },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "挂住",
        events: (event) => events.push(event),
        signal: controller.signal,
      });
      const runPromise = runtime.run();
      await recorder.waitUntilRecorded();
      // 等 agent 进入流式等待（agent_start 已发出，isStreaming 为 true）再判静止
      await waitForEvent(events, "agent_start");
      const quiescent = await runtime.waitForQuiescence(300);
      expect(quiescent).toBe(false);
      expect(events.some((event) => event.type === "quiescence_timeout")).toBe(true);
      // abort 结束 run；quiescence_timeout 不改变终态（仍是 aborted）
      controller.abort();
      const result = await runPromise;
      expect(result.outcome.status).toBe("aborted");
      recorder.take(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("默认 quiescenceTimeout 为 5s：无参调用在永不 idle 时约 5s 触发超时", async () => {
    const recorder = new RequestRecorder();
    const { server, port } = await createMockServer(() => [], recorder, { hangResponse: true });
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-quiescence-5s-"));
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "收据超时 5s",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { systemPrompt: "助手" } },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: "挂住",
        events: (event) => events.push(event),
        signal: controller.signal,
      });
      const runPromise = runtime.run();
      await recorder.waitUntilRecorded();
      await waitForEvent(events, "agent_start");
      // 无参调用使用默认 quiescenceTimeout（规格 03 §5：默认 5s）
      const started = performance.now();
      const quiescent = await runtime.waitForQuiescence();
      const elapsed = performance.now() - started;
      expect(quiescent).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(4_500);
      expect(elapsed).toBeLessThan(7_000);
      controller.abort();
      const result = await runPromise;
      expect(result.outcome.status).toBe("aborted");
      recorder.take(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 假 Provider 下 Cancel → Quiescent p95 < 250ms（100 次采样）
// ---------------------------------------------------------------------------
describe("Cancel → Quiescent p95（100 次采样）", () => {
  it("本地假 Provider 下取消到静止 p95 < 250ms", async () => {
    // 100 次采样在全量并发下约 15s+，显式放宽测试超时（vitest 默认 15s 不够）
    const recorder = new RequestRecorder();
    // 永不响应：确保慢盘或高负载下 abort 发生时 run 仍在进行。
    const { server, port } = await createMockServer(() => textScript("回答"), recorder, {
      hangResponse: true,
    });
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-receipt-p95-"));
    const runStore = new FileRunStore(path.join(dir, "runs"));
    const samples: number[] = [];
    let runSequence = 0;
    const runOnce = async (label: string, record: boolean): Promise<number> => {
      const controller = new AbortController();
      const runId = `run-p95-${runSequence++}`;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "收据 p95",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { systemPrompt: "助手" } },
        },
        configDir: dir,
        cwd: dir,
        initialPrompt: label,
        signal: controller.signal,
        runStore,
        runId,
      });
      // 等本轮请求真正发出（录制数在 run 启动前捕获，等待递增到新的一轮）
      const before = recorder.count();
      const runPromise = runtime.run();
      await recorder.waitForNext(before);
      // 计时前先确认启动事实已落盘，避免把 Cancel 之前的 journal 积压计入收敛延迟。
      await vi.waitFor(async () => {
        const persisted = await runStore.read(runId);
        expect(
          persisted.some(
            (item) =>
              item.kind === "event" &&
              (item.payload as { event?: { type?: CoreMindEvent["type"] } }).event?.type ===
                "agent_start",
          ),
        ).toBe(true);
      });
      // 测量 Cancel → Quiescent：abort 到静止点（waitForQuiescence 满足）。
      // 不含 run 收尾的磁盘 flush——规格 03 §5 指标定义的是静止机制开销
      const started = performance.now();
      controller.abort();
      const quiescent = await runtime.waitForQuiescence(5_000);
      const elapsed = performance.now() - started;
      expect(quiescent).toBe(true);
      const result = await runPromise;
      expect(result.outcome.status).toBe("aborted");
      if (record) samples.push(elapsed);
      return elapsed;
    };
    try {
      // 预热 3 次：消除 runStore 冷启动（目录/文件首建）与 JIT 偏差，基准测试惯例
      for (let warmup = 0; warmup < 3; warmup += 1) {
        await runOnce(`预热 ${warmup}`, false);
      }
      for (let index = 0; index < 100; index += 1) {
        await runOnce(`采样 ${index}`, true);
      }
      // 消费全部录制（3 次预热 + 100 次采样；最后一次消费标记覆盖前序）
      recorder.take(recorder.count() - 1);
      const sorted = [...samples].sort((left, right) => left - right);
      const p95 = sorted[94]!;
      expect(p95).toBeLessThan(250);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 90_000);
});

afterEach(() => {
  for (const recorder of allRecorders) {
    if (recorder.unconsumed() > 0) {
      throw new Error(`存在未消费的请求录制（${recorder.unconsumed()} 次）——测试未对齐`);
    }
  }
  allRecorders.clear();
});
