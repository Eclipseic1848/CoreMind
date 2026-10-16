import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CoreMindConfig, validateConfig } from "coremind-config";
import { describe, expect, it, type TestContext, vi } from "vitest";
import {
  fingerprintEffectReceiptValue,
  validateEffectReceiptBindingsAgainstFacts,
} from "./effect-receipt-binding.js";
import { ProjectionEngine } from "./projection.js";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions } from "./runtime.js";

interface WireMessage {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_call_id?: string;
}
interface WireRequest {
  model: string;
  messages: WireMessage[];
}
interface HttpProbe {
  directory: string;
  port: number;
  requests: WireRequest[];
  create(
    options: Pick<
      CoreMindRuntimeOptions,
      "config" | "initialPrompt" | "sessionId" | "resumeRunId" | "approveTool" | "toolDefinitions"
    >,
  ): Promise<CoreMindRuntime>;
}

const duplicateCases = [
  ["跨轮相同 Call 身份", true],
  ["跨轮不同 Call 身份", false],
] as const;

describe("未知工具身份的事实准入", () => {
  it.for(duplicateCases)("%s 不损坏持久收据", async ([_name, duplicate], context) => {
    const firstId = "call-unknown-first";
    const secondId = duplicate ? firstId : "call-unknown-second";
    const args = { path: "article.md", content: "未知工具不得写入" };
    await withHttp(
      context,
      (request, ordinal) => {
        if (ordinal > 1) {
          const replies = request.messages.filter((message) => message.role === "tool");
          expect(replies.map((message) => message.tool_call_id)).toEqual(
            ordinal === 2 ? [firstId] : [firstId, secondId],
          );
          expect(messageText(replies.at(-1))).toContain("missing_tool");
        }
        return ordinal < 3
          ? unknownCall(ordinal === 1 ? firstId : secondId, args)
          : answer("未知工具反馈已处理");
      },
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, "原始文件保持不变🙂", "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: config(probe.port),
          initialPrompt: "请求目录中不存在的工具后继续",
          approveTool: approve,
        });
        // 旧缺陷会在最终投影时 reject；必须由真实 Runtime 返回稳定终态。
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome).toMatchObject(
          duplicate
            ? { status: "failed", error: { code: "effect_receipt_conflict" } }
            : { status: "succeeded" },
        );
        expect(probe.requests).toHaveLength(duplicate ? 2 : 3);
        expect(approve).not.toHaveBeenCalled();
        expect(readFileSync(target, "utf8")).toBe("原始文件保持不变🙂");
        const ids = duplicate ? [firstId] : [firstId, secondId];
        const store = new FileRunStore(path.join(probe.directory, "runs"));
        const records = await store.read(result.runId);
        const projection = ProjectionEngine.project(records);
        expect(projection.outcome).toEqual(result.outcome);
        expect(projection.status).toBe("finished");
        for (const events of [
          result.trace.map((entry) => entry.event),
          projection.trace.map((entry) => entry.event),
        ]) {
          const calls = events.filter((event) => event.type === "tool_call");
          expect(calls.map((event) => event.callId)).toEqual(ids);
          expect(calls.every((event) => event.tool === "missing_tool")).toBe(true);
          expect(calls.map((event) => event.argumentsFingerprint)).toEqual(
            ids.map(() => fingerprintEffectReceiptValue(args)),
          );
          expect(events.filter((event) => event.type === "effect_receipt")).toHaveLength(
            ids.length,
          );
          const receipts = validateEffectReceiptBindingsAgainstFacts(result.runId, events);
          expect(receipts).toHaveLength(ids.length);
          expect(receipts.map((receipt) => receipt.status)).toEqual(ids.map(() => "not_started"));
          expect(receipts.map((receipt) => receipt.binding?.callId)).toEqual(ids);
          expect(new Set(receipts.map((receipt) => receipt.idempotencyKey)).size).toBe(ids.length);
          for (const callId of ids) {
            expect(events).toContainEqual(
              expect.objectContaining({
                type: "tool_lifecycle",
                callId,
                resolution: expect.objectContaining({
                  phase: "observed",
                  status: "skipped",
                  result: expect.objectContaining({
                    executionOutcome: "not_invoked",
                    effectState: "not_started",
                  }),
                }),
              }),
            );
            expect(events).toContainEqual(
              expect.objectContaining({
                type: "tool_lifecycle",
                callId,
                resolution: expect.objectContaining({ phase: "terminal", status: "completed" }),
              }),
            );
          }
          expect(
            events.some(
              (event) =>
                event.type === "checkpoint_created" ||
                event.type === "tool_execution_evidence" ||
                (event.type === "tool_lifecycle" &&
                  event.resolution.phase === "executing" &&
                  event.resolution.status === "completed"),
            ),
          ).toBe(false);
        }
      },
      // before 可正常发完第三轮，不能靠夹具提前拦截制造假红。
      3,
    );
  });
});

const resumeCases = [
  ["恢复时重用旧 Call 身份", true],
  ["恢复时使用新 Call 身份", false],
] as const;

describe("持久恢复的工具身份冻结", () => {
  it.for(resumeCases)("%s 保留首轮事实", async ([_name, duplicate], context) => {
    const firstId = "call-paused-write";
    const nextId = duplicate ? firstId : "call-resumed-write";
    const args = { path: "article.md", content: "恢复后完整正文🙂" };
    const original = "审批拒绝后必须保留的正文🙂";
    await withHttp(
      context,
      (_request, ordinal) =>
        ordinal < 3 ? writeCall(ordinal === 1 ? firstId : nextId, args) : answer("恢复完成"),
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const sharedConfig = resumeConfig(probe.port);
        const prompt = "写入 article.md 后报告完成";
        const deny = vi.fn(async () => "deny" as const);
        const firstRuntime = await probe.create({
          config: sharedConfig,
          initialPrompt: prompt,
          approveTool: deny,
        });
        const first = await firstRuntime.run();
        expect(await firstRuntime.waitForQuiescence()).toBe(true);
        expect(first.outcome).toMatchObject({
          status: "paused",
          finishReason: "tool_approval_denied",
        });
        expect(probe.requests).toHaveLength(1);
        expect(deny).toHaveBeenCalledOnce();
        expect(readFileSync(target, "utf8")).toBe(original);
        const store = new FileRunStore(path.join(probe.directory, "runs"));
        const before = await store.read(first.runId);
        expect(before.at(-1)?.kind).toBe("pause");
        expect(ProjectionEngine.project(before).outcome).toEqual(first.outcome);
        const prefix = readFileSync(store.pathFor(first.runId));
        const allow = vi.fn(async () => "allow" as const);
        const resumedRuntime = await probe.create({
          config: sharedConfig,
          initialPrompt: prompt,
          resumeRunId: first.runId,
          approveTool: allow,
        });
        const resumed = await resumedRuntime.run();
        expect(await resumedRuntime.waitForQuiescence()).toBe(true);
        expect(resumed.runId).toBe(first.runId);
        expect(resumed.outcome).toMatchObject(
          duplicate
            ? { status: "failed", error: { code: "effect_receipt_conflict" } }
            : { status: "succeeded" },
        );
        expect(probe.requests).toHaveLength(duplicate ? 2 : 3);
        expect(allow).toHaveBeenCalledTimes(duplicate ? 0 : 1);
        expect(readFileSync(target, "utf8")).toBe(duplicate ? original : args.content);
        expect(readFileSync(store.pathFor(first.runId)).subarray(0, prefix.length)).toEqual(prefix);
        const records = await store.read(first.runId);
        expect(records.map((record) => record.sequence)).toEqual(
          records.map((_record, index) => index + 1),
        );
        const projection = ProjectionEngine.project(records);
        expect(projection.outcome).toEqual(resumed.outcome);
        const events = projection.trace.map((entry) => entry.event);
        const calls = events.filter((event) => event.type === "tool_call");
        expect(calls.map((call) => call.callId)).toEqual(duplicate ? [firstId] : [firstId, nextId]);
        expect(
          calls.every((call) => call.argumentsFingerprint === fingerprintEffectReceiptValue(args)),
        ).toBe(true);
        const receipts = validateEffectReceiptBindingsAgainstFacts(first.runId, events);
        expect(receipts).toHaveLength(duplicate ? 1 : 2);
        expect(receipts.find((receipt) => receipt.binding?.callId === firstId)).toMatchObject({
          status: "not_started",
          provenance: "bound",
        });
        expect(
          events.filter((event) => event.type === "effect_receipt").map((event) => event.status),
        ).toEqual(duplicate ? ["not_started"] : ["not_started", "started", "committed"]);
        // not_started 不属于幂等未知效果的重试，不伪造 tool_attempt。
        expect(events.some((event) => event.type === "tool_attempt")).toBe(false);
        if (!duplicate) {
          expect(receipts.find((receipt) => receipt.binding?.callId === nextId)).toMatchObject({
            status: "committed",
          });
          const reply = probe.requests[2]!.messages.find((message) => message.role === "tool");
          expect(reply?.tool_call_id).toBe(nextId);
        }
      },
      3,
    );
  });
});

it("批内两个完整未知工具调用复用同一身份时拒绝第二个", async (context) => {
  const callId = "call-batch-duplicate";
  const firstArgs = { path: "article.md", content: "批内第一份完整参数" };
  const secondArgs = { path: "article.md", content: "批内第二份完整参数" };
  await withHttp(
    context,
    (_request, ordinal) => {
      if (ordinal > 1) return answer("批内未知工具反馈已处理");
      return [
        {
          id: "batch-unknown",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                // 先按两个index建独立块，再补ID；避免同ID首delta被解析器合并。
                tool_calls: [
                  { index: 0, type: "function", function: { name: "missing_tool" } },
                  { index: 1, type: "function", function: { name: "missing_tool" } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "batch-unknown",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: callId, function: { arguments: JSON.stringify(firstArgs) } },
                  { index: 1, id: callId, function: { arguments: JSON.stringify(secondArgs) } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: "batch-unknown", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ];
    },
    async (probe) => {
      const target = path.join(probe.directory, "article.md");
      writeFileSync(target, "批内调用不得改变文件🙂", "utf8");
      const approve = vi.fn(async () => "allow" as const);
      const runtime = await probe.create({
        config: config(probe.port),
        initialPrompt: "处理同一批工具请求",
        approveTool: approve,
      });
      const result = await runtime.run();
      expect(await runtime.waitForQuiescence()).toBe(true);
      expect(result.outcome).toMatchObject({
        status: "failed",
        error: { code: "effect_receipt_conflict" },
      });
      expect(probe.requests).toHaveLength(1);
      expect(approve).not.toHaveBeenCalled();
      expect(readFileSync(target, "utf8")).toBe("批内调用不得改变文件🙂");
      const records = await new FileRunStore(path.join(probe.directory, "runs")).read(result.runId);
      const projection = ProjectionEngine.project(records);
      expect(projection.outcome).toEqual(result.outcome);
      const events = projection.trace.map((entry) => entry.event);
      expect(events.filter((event) => event.type === "tool_call")).toEqual([
        expect.objectContaining({
          callId,
          tool: "missing_tool",
          argumentsFingerprint: fingerprintEffectReceiptValue(firstArgs),
        }),
      ]);
      expect(events.filter((event) => event.type === "effect_receipt")).toHaveLength(1);
      expect(validateEffectReceiptBindingsAgainstFacts(result.runId, events)).toEqual([
        expect.objectContaining({
          status: "not_started",
          binding: expect.objectContaining({
            callId,
            argumentsFingerprint: fingerprintEffectReceiptValue(firstArgs),
          }),
        }),
      ]);
      // 第二个start发生时首结果finalizer可能仍在微任务中，最终必须真实完成首生命周期。
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_lifecycle",
          callId,
          resolution: expect.objectContaining({ phase: "terminal", status: "completed" }),
        }),
      );
      expect(
        events.some(
          (event) =>
            event.type === "checkpoint_created" ||
            event.type === "tool_execution_evidence" ||
            (event.type === "tool_lifecycle" &&
              event.resolution.phase === "executing" &&
              event.resolution.status === "completed"),
        ),
      ).toBe(false);
    },
    // 若Provider误合并为一个call，允许第二HTTP正常结束，使该格明确失败。
    2,
  );
});

function config(port: number): CoreMindConfig {
  return validateConfig({
    schemaVersion: 2,
    name: "未知工具重复身份回归",
    defaultAgent: "main",
    provider: {
      id: "local-probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    tools: [],
    agents: { main: { systemPrompt: "按要求执行", tools: [] } },
    permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    runtime: { maxTurns: 6, maxToolCalls: 8, maxRetries: 0, runTimeoutMs: 10_000 },
  });
}

function unknownCall(callId: string, args: Record<string, string>): unknown[] {
  return [
    {
      id: "unknown-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "missing_tool", arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "unknown-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function resumeConfig(port: number): CoreMindConfig {
  return validateConfig({
    schemaVersion: 2,
    name: "持久恢复工具身份回归",
    defaultAgent: "main",
    provider: {
      id: "local-probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    tools: [{ id: "write" }],
    agents: { main: { systemPrompt: "按要求执行", tools: [{ id: "write" }] } },
    permissions: { mode: "ask", workspaceOnly: true, network: "deny" },
    runtime: { maxTurns: 6, maxToolCalls: 8, maxRetries: 0, runTimeoutMs: 10_000 },
  });
}

function writeCall(callId: string, args: Record<string, string>): unknown[] {
  return [
    {
      id: "resume-tool",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "write", arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "resume-tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

function answer(text: string): unknown[] {
  return [
    {
      id: "answer",
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    },
    { id: "answer", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function messageText(message: WireMessage | undefined): string {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content.map((block: { text?: string }) => block.text ?? "").join("")
    : "";
}

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function withHttp(
  context: TestContext,
  reply: (request: WireRequest, ordinal: number) => unknown[],
  check: (probe: HttpProbe) => Promise<void>,
  maxRequests: number,
): Promise<void> {
  const root = path.resolve(tmpdir());
  const directory = mkdtempSync(path.join(root, "coremind-provider-regression-"));
  const requests: WireRequest[] = [];
  const failures: unknown[] = [];
  const runtimes: CoreMindRuntime[] = [];
  const controller = new AbortController();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions")
          throw new Error("请求路径不符");
        requests.push(JSON.parse(body) as WireRequest);
        if (requests.length > maxRequests) throw new Error("请求次数超过本格上限");
        sendSse(response, reply(requests.at(-1)!, requests.length));
      } catch (error) {
        failures.push(error);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "本地回归服务拒绝额外请求" } }));
      }
    });
  });
  let body: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const cancel = () => {
    controller.abort();
    server.closeAllConnections();
  };
  const close = () =>
    (closing ??= (async () => {
      cancel();
      await body?.catch(() => undefined);
      let quiescent = true;
      try {
        for (const runtime of runtimes) {
          if (!(await runtime.waitForQuiescence())) quiescent = false;
        }
        expect(quiescent).toBe(true);
      } finally {
        try {
          if (server.listening)
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
        } finally {
          context.signal.removeEventListener("abort", cancel);
          if (quiescent) {
            expect(path.dirname(path.resolve(directory))).toBe(root);
            expect(path.basename(directory).startsWith("coremind-provider-regression-")).toBe(true);
            rmSync(directory, { recursive: true, force: true });
          }
        }
      }
    })());
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(close);
  if (context.signal.aborted) cancel();
  body = (async () => {
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    controller.signal.throwIfAborted();
    await check({
      directory,
      requests,
      port: (server.address() as AddressInfo).port,
      create: async (options) => {
        const runtime = await CoreMindRuntime.create({
          configDir: directory,
          cwd: directory,
          env: { COREMIND_TEST_API_KEY: "test-only" },
          signal: controller.signal,
          runStore: new FileRunStore(path.join(directory, "runs")),
          ...options,
          config: validateConfig(options.config),
        });
        runtimes.push(runtime);
        return runtime;
      },
    });
    expect(failures).toEqual([]);
  })();
  try {
    await body;
  } finally {
    await close();
  }
}
