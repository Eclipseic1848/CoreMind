import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentMessage, CompactionEntry } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { buildStableContextPrefix } from "./context.js";
import type { CoreMindEvent } from "./events.js";
import { type RequestMessage, rebuildRunRequest } from "./rebuild-request.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";

/**
 * 请求重建验收套件（Issue #39 / 规格 04 门 A-1）：
 * 固定消息序列 fixture 覆盖纯文本多轮、工具调用+结果、审批拒绝（not_started）、
 * 压缩触发、重试、断流恢复。假 Provider 记录实际发送，Run 结束后从持久事实重建并逐条比对。
 */

// ---------------------------------------------------------------------------
// 录制器：假 Provider 记录每次请求；测试逐次消费；结束时断言无未消费（为 0.3.x-C 回放打基础）。
// 全局追踪全部实例，afterEach 统一断言，未消费录制必然使测试失败。
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

  /** 消费第 index 次请求（越界抛错，暴露录制未对齐） */
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

  /** 等待至少录制到一次请求（abort 等时序控制用） */
  async waitUntilRecorded(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.recorded.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.recorded.length === 0) throw new Error("等待请求录制超时");
  }

  /** 未消费的录制次数（测试结束必须为 0） */
  unconsumed(): number {
    return this.recorded.length - this.consumed;
  }
}

/** fixture 运行结果：发送请求、事件、会话树条目、压缩条目、stablePrefix 指纹 */
interface FixtureOutcome {
  result: Awaited<ReturnType<CoreMindRuntime["run"]>>;
  recorder: RequestRecorder;
  events: CoreMindEvent[];
  entries: Awaited<ReturnType<CoreMindSession["branchEntries"]>>;
  compactions: CompactionEntry[];
  prefixFingerprint: string;
}

/** 脚本响应：SSE chunks 或错误（用于重试 fixture） */
type MockScriptResult =
  | Array<Record<string, unknown>>
  | { error: { status: number; message: string } };

/** 假 Provider 服务器：脚本化响应，记录每次请求的 messages 到 recorder */
function createMockServer(
  script: (messages: unknown[], attempt: number) => MockScriptResult,
  recorder: RequestRecorder,
  onRequest?: (request: { messages: unknown[]; model?: string; tools?: unknown }) => void,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as {
          messages: unknown[];
          model?: string;
          tools?: unknown;
        };
        recorder.record(parsed.messages);
        onRequest?.(parsed);
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
        // 请求带 stream_options.include_usage，需返回 usage chunk（真实 provider 行为）
        response.write(
          `data: ${JSON.stringify({
            id: "usage",
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port });
    });
  });
}

/** 运行一个 fixture：预置会话树历史 → run() → 重开会话树取条目与压缩 → 重建前缀 */
async function runFixture(options: {
  sessionId: string;
  initialPrompt: string;
  baseConfig: (port: number) => Record<string, unknown>;
  serverScript: (messages: unknown[], attempt: number) => MockScriptResult;
  sessionHistory?: AgentMessage[];
  approveTool?: (request: { tool: string }) => Promise<"allow" | "deny">;
  onRequest?: (request: { messages: unknown[]; model?: string; tools?: unknown }) => void;
  maxRetries?: number;
}): Promise<FixtureOutcome> {
  const recorder = new RequestRecorder();
  const { server, port } = await createMockServer(
    options.serverScript,
    recorder,
    options.onRequest,
  );
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-rebuild-"));
  writeFileSync(path.join(dir, "notes.txt"), "文件内容", "utf8");
  const events: CoreMindEvent[] = [];
  try {
    // 预置固定会话树历史（fixture 的固定消息序列）
    const sessionDir = path.join(dir, "sessions");
    const cm = await CoreMindSession.open({
      dir: sessionDir,
      sessionId: options.sessionId,
      cwd: dir,
    });
    if (options.sessionHistory) await cm.appendMessages(options.sessionHistory);

    const runtime = await CoreMindRuntime.create({
      config: options.baseConfig(port) as Parameters<typeof CoreMindRuntime.create>[0]["config"],
      configDir: dir,
      cwd: dir,
      sessionId: options.sessionId,
      initialPrompt: options.initialPrompt,
      events: (event) => events.push(event),
      ...(options.approveTool ? { approveTool: options.approveTool } : {}),
      ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    });
    const result = await runtime.run();

    const reopened = await CoreMindSession.open({
      dir: sessionDir,
      sessionId: options.sessionId,
      cwd: dir,
    });
    const entries = await reopened.branchEntries();
    const compactions = entries.filter(
      (entry): entry is CompactionEntry => entry.type === "compaction",
    );
    const contextPrefix = events.find((event) => event.type === "context_prefix");
    return {
      result,
      recorder,
      events,
      entries,
      compactions,
      prefixFingerprint: (contextPrefix as { fingerprint?: string } | undefined)?.fingerprint ?? "",
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 与 agent-factory 相同输入构造稳定前缀（供重建） */
function makeStablePrefix(
  projectInstructions: string,
  toolNames: string[],
): { text: string; fingerprint: string } {
  return buildStableContextPrefix({
    projectInstructions,
    tools: toolNames.map((name) => ({ name, description: toolDescription(name) })),
    stableFacts: { provider: "probe", model: "probe-model", contextWindow: 32768 },
  });
}

/** fixture 用到的工具描述（与 mock 环境一致即可，指纹比对不依赖精确描述） */
function toolDescription(name: string): string {
  return `工具 ${name} 的契约描述`;
}

/** 构造完整 assistant 回复消息（恢复历史要求携带 usage，否则运行时崩溃） */
function assistantMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "probe",
    model: "probe-model",
    stopReason: "stop",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// 归一化比较：wire 格式 ↔ 重建格式 → 统一消息签名（内容、顺序、工具 schema、模型路由）
// ---------------------------------------------------------------------------
interface MessageSignature {
  role: string;
  text: string;
  toolCalls?: Array<{ name: string; args: string }>;
  toolName?: string;
  model?: string;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (item && typeof item === "object" && "text" in item ? String(item.text) : ""))
      .join("");
  }
  return "";
}

/** 稳定 JSON 序列化（键排序，跨 wire/内部格式一致） */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/** wire（OpenAI 兼容）消息 → 签名 */
function wireSignatures(messages: unknown[]): MessageSignature[] {
  const toolCallIds = new Map<string, string>();
  const result: MessageSignature[] = [];
  for (const raw of messages) {
    const message = raw as {
      role?: string;
      content?: unknown;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      tool_call_id?: string;
      model?: string;
    };
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const calls = message.tool_calls.map((call) => {
        toolCallIds.set(call.id, call.function.name);
        return { name: call.function.name, args: stableJson(JSON.parse(call.function.arguments)) };
      });
      result.push({ role: "assistant", text: textOf(message.content), toolCalls: calls });
      continue;
    }
    if (message.role === "tool") {
      result.push({
        role: "tool",
        text: textOf(message.content),
        toolName: message.tool_call_id ? toolCallIds.get(message.tool_call_id) : undefined,
      });
      continue;
    }
    result.push({ role: message.role ?? "", text: textOf(message.content) });
  }
  return result;
}

/** 重建消息（内部格式）→ 签名 */
function rebuildSignatures(messages: RequestMessage[]): MessageSignature[] {
  return messages.map((message) => {
    if (message.role === "assistant") {
      const content = message.content as Array<{
        type?: string;
        id?: string;
        name?: string;
        arguments?: unknown;
      }>;
      const calls = content
        .filter((item) => item.type === "toolCall")
        .map((call) => ({ name: String(call.name), args: stableJson(call.arguments) }));
      if (calls.length > 0) {
        return { role: "assistant", text: "", toolCalls: calls };
      }
      return { role: "assistant", text: textOf(content) };
    }
    if (message.role === "toolResult") {
      return {
        role: "tool",
        text: textOf(message.content),
        toolName: message.toolName,
      };
    }
    return { role: message.role, text: textOf("content" in message ? message.content : "") };
  });
}

/** 重建该 fixture 的完整请求消息（系统前缀 + 应用压缩 + 本轮） */
function rebuildFixture(
  outcome: FixtureOutcome,
  projectInstructions: string,
  toolNames: string[],
): RequestMessage[] {
  const stablePrefix = makeStablePrefix(projectInstructions, toolNames);
  return rebuildRunRequest({
    entries: outcome.entries,
    compactions: outcome.compactions,
    stablePrefix,
  });
}

// ---------------------------------------------------------------------------
// 6 类 fixture
// ---------------------------------------------------------------------------
describe("Provider 请求重建验收（门 A-1）", () => {
  afterEach(() => {
    // 未消费录制使测试失败（规格 04 门 A-1）：所有 recorder 的每次请求必须被消费比对
    for (const recorder of allRecorders) {
      expect(recorder.unconsumed(), "存在未消费的录制请求（应全部参与比对）").toBe(0);
    }
    allRecorders.clear();
  });

  it("fixture 1：纯文本多轮——重建消息 == 实际发送（含历史）", async () => {
    const sessionHistory: AgentMessage[] = [
      { role: "user", content: "第一问", timestamp: 0 } as AgentMessage,
      assistantMsg("第一答"),
      { role: "user", content: "第二问", timestamp: 0 } as AgentMessage,
      assistantMsg("第二答"),
    ];
    const outcome = await runFixture({
      sessionId: "s1",
      initialPrompt: "第三问",
      sessionHistory,
      baseConfig: (port) => ({
        schemaVersion: 2,
        name: "纯文本多轮",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "助手" } },
        session: { enabled: true },
      }),
      serverScript: () => [
        {
          id: "a",
          choices: [
            { index: 0, delta: { role: "assistant", content: "第三答" }, finish_reason: null },
          ],
        },
        { id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ],
    });

    // 只发出一次请求；重建（非 system 部分）== 发送
    expect(outcome.recorder.count()).toBe(1);
    const sent = outcome.recorder.take(0).filter((m) => (m as { role?: string }).role !== "system");
    const rebuilt = rebuildFixture(outcome, "助手", []);
    const rebuiltNoSystem = rebuilt.filter((m) => m.role !== "system");
    expect(rebuildSignatures(rebuiltNoSystem)).toEqual(wireSignatures(sent));
    // 前缀指纹与运行期 context_prefix 事件一致（确定性前缀可重建）
    expect(outcome.prefixFingerprint).toBe(makeStablePrefix("助手", []).fingerprint);
    // 无未消费录制
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("fixture 2：工具调用+结果——重建含 toolCall 与 toolResult，工具 schema 与模型路由一致", async () => {
    const requestMeta: Array<{ model?: string; tools?: unknown }> = [];
    const outcome = await runFixture({
      sessionId: "s2",
      initialPrompt: "读文件",
      baseConfig: (port) => ({
        schemaVersion: 2,
        name: "工具调用",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        tools: [{ id: "read" }],
        agents: { main: { systemPrompt: "调用工具" } },
        permissions: { mode: "full" },
        session: { enabled: true },
      }),
      serverScript: (messages) =>
        messages.some((m) => (m as { role?: string }).role === "tool")
          ? [
              {
                id: "f",
                choices: [
                  { index: 0, delta: { role: "assistant", content: "完成" }, finish_reason: null },
                ],
              },
              { id: "f", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
            ]
          : [
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
                          id: "call-read",
                          type: "function",
                          function: { name: "read", arguments: '{"path":"notes.txt"}' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            ],
      onRequest: (request) => {
        // 记录每次请求的 model 与 tools schema 供断言
        requestMeta.push({ model: request.model, tools: request.tools });
      },
    });

    // 两次请求；重建（非 system）== 最后一次发送（累积上下文）
    expect(outcome.recorder.count()).toBe(2);
    const sent = outcome.recorder.take(1).filter((m) => (m as { role?: string }).role !== "system");
    const rebuilt = rebuildFixture(outcome, "调用工具", ["read"]).filter(
      (m) => m.role !== "system",
    );
    expect(rebuildSignatures(rebuilt)).toEqual(wireSignatures(sent));
    // 模型路由与工具 schema：发送请求的 model 与 tools 声明一致
    expect(requestMeta[0]?.model).toBe("probe-model");
    expect(JSON.stringify(requestMeta[0]?.tools)).toContain("read");
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("fixture 3：审批拒绝（not_started）——重建 == 发送，无副作用结果，receipt 为 not_started", async () => {
    const outcome = await runFixture({
      sessionId: "s3",
      initialPrompt: "读文件",
      baseConfig: (port) => ({
        schemaVersion: 2,
        name: "审批拒绝",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        tools: [{ id: "read" }],
        agents: { main: { systemPrompt: "调用工具" } },
        permissions: { mode: "ask" },
        session: { enabled: true },
      }),
      serverScript: () => [
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
                    id: "call-read",
                    type: "function",
                    function: { name: "read", arguments: '{"path":"notes.txt"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: "t", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ],
      approveTool: async () => "deny",
    });

    // 审批拒绝：只发出一次请求，效果收据为 not_started
    expect(outcome.recorder.count()).toBe(1);
    const sent = outcome.recorder.take(0).filter((m) => (m as { role?: string }).role !== "system");
    const rebuilt = rebuildFixture(outcome, "调用工具", ["read"]).filter(
      (m) => m.role !== "system",
    );
    // 孤立 toolUse 产出不发送：重建 == 发送（仅 prompt）
    expect(rebuildSignatures(rebuilt)).toEqual(wireSignatures(sent));
    // effect_receipt not_started
    const notStarted = outcome.events.filter(
      (event) => event.type === "effect_receipt" && event.status === "not_started",
    );
    expect(notStarted.length).toBe(1);
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("fixture 4：压缩触发——重建应用压缩摘要替换，与发送逐条一致（摘要替换位置）", async () => {
    const long = "旧历史内容".repeat(80);
    const sessionHistory: AgentMessage[] = [
      { role: "user", content: `${long}一`, timestamp: 0 } as AgentMessage,
      assistantMsg(`${long}二`),
      { role: "user", content: `${long}三`, timestamp: 0 } as AgentMessage,
      assistantMsg(`${long}四`),
      { role: "user", content: `${long}五`, timestamp: 0 } as AgentMessage,
    ];
    const outcome = await runFixture({
      sessionId: "s4",
      initialPrompt: "继续完成",
      sessionHistory,
      baseConfig: (port) => ({
        schemaVersion: 2,
        name: "压缩触发",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
          contextWindow: 300,
        },
        agents: { main: { systemPrompt: "测试助手" } },
        session: { enabled: true },
      }),
      serverScript: () => [
        {
          id: "c",
          choices: [
            { index: 0, delta: { role: "assistant", content: "已继续" }, finish_reason: null },
          ],
        },
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ],
    });

    // 压缩发生：context_compacted 事件 + 会话树压缩条目（只带引用，不含摘要正文）
    expect(outcome.events.some((event) => event.type === "context_compacted")).toBe(true);
    expect(outcome.compactions.length).toBe(1);
    const compactedEvent = outcome.events.find((event) => event.type === "context_compacted") as {
      summaryFingerprint?: string;
      sessionEntryId?: string;
    };
    expect(compactedEvent.summaryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(typeof compactedEvent.sessionEntryId).toBe("string");

    // 重建（应用压缩）== 实际发送（逐条内容、顺序）
    const sent = outcome.recorder.take(0).filter((m) => (m as { role?: string }).role !== "system");
    const rebuilt = rebuildFixture(outcome, "测试助手", []).filter((m) => m.role !== "system");
    expect(rebuildSignatures(rebuilt)).toEqual(wireSignatures(sent));
    // 摘要替换位置：重建第一条是本地确定性压缩摘要（user 角色）
    expect(rebuilt[0]).toMatchObject({ role: "user" });
    expect(String((rebuilt[0] as { content: string }).content)).toContain("CoreMind 上下文摘要");
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("fixture 5：重试——首次 5xx 后重试发送相同请求，重建 == 最终发送", async () => {
    const outcome = await runFixture({
      sessionId: "s5",
      initialPrompt: "你好",
      baseConfig: (port) => ({
        schemaVersion: 2,
        name: "重试",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "助手" } },
        session: { enabled: true },
        runtime: { maxRetries: 1 },
      }),
      serverScript: (_messages, attempt) => {
        if (attempt === 1) {
          return { error: { status: 500, message: "transient failure" } };
        }
        return [
          {
            id: "r",
            choices: [
              { index: 0, delta: { role: "assistant", content: "重试成功" }, finish_reason: null },
            ],
          },
          { id: "r", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
      },
    });

    // 首次 5xx 触发 provider 层重试，第二次成功；两次请求内容一致
    expect(outcome.recorder.count()).toBe(2);
    const first = outcome.recorder.take(0);
    const second = outcome.recorder.take(1);
    // 重试发送相同请求（内容一致）
    expect(wireSignatures(first.filter((m) => (m as { role?: string }).role !== "system"))).toEqual(
      wireSignatures(second.filter((m) => (m as { role?: string }).role !== "system")),
    );
    // 重建 == 最终发送
    const sent = second.filter((m) => (m as { role?: string }).role !== "system");
    const rebuilt = rebuildFixture(outcome, "助手", []).filter((m) => m.role !== "system");
    expect(rebuildSignatures(rebuilt)).toEqual(wireSignatures(sent));
    expect(outcome.recorder.unconsumed()).toBe(0);
  });

  it("fixture 6：断流恢复（abort）——重建 == 发送的已确认部分，竞态赢家文本不落盘", async () => {
    const recorder = new RequestRecorder();
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const parsed = JSON.parse(body) as { messages: unknown[] };
        recorder.record(parsed.messages);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // 发送部分文本后挂起（模拟断流）
        response.write(
          `data: ${JSON.stringify({
            id: "a",
            choices: [
              { index: 0, delta: { role: "assistant", content: "部分文本" }, finish_reason: null },
            ],
          })}\n\n`,
        );
        setTimeout(() => response.end("data: [DONE]\n\n"), 2_000);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-rebuild-abort-"));
    const controller = new AbortController();
    try {
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "断流恢复",
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
        sessionId: "s6",
        initialPrompt: "你好",
        signal: controller.signal,
      });
      const runPromise = runtime.run();
      // 等待请求已发出、流已开始再中断（并发下避免 abort 早于请求发送）
      await recorder.waitUntilRecorded();
      controller.abort();
      const result = await runPromise;

      // 断流中止：outcome aborted；会话树只写已确认部分（prompt，无竞态赢家文本）
      expect(result.outcome.status).toBe("aborted");
      const cm = await CoreMindSession.open({
        dir: path.join(dir, "sessions"),
        sessionId: "s6",
        cwd: dir,
      });
      const entries = await cm.branchEntries();
      expect(
        entries.filter((entry) => entry.type === "message").map((entry) => entry.message?.role),
      ).toEqual(["user"]);
      // 重建（非 system）== 发送的已确认请求
      const sent = recorder.take(0).filter((m) => (m as { role?: string }).role !== "system");
      const rebuilt = rebuildRunRequest({
        entries,
        compactions: entries.filter((entry) => entry.type === "compaction"),
        stablePrefix: makeStablePrefix("助手", []),
      }).filter((m) => m.role !== "system");
      expect(rebuildSignatures(rebuilt)).toEqual(wireSignatures(sent));
      expect(recorder.unconsumed()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
