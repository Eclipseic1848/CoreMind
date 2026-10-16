import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type CoreMindConfig, validateConfig } from "coremind-config";
import { describe, expect, it, type TestContext, vi } from "vitest";
import { type AgentDriver, type AgentDriverHarness, FakeAgentDriver } from "./agent-driver.js";
import { validateEffectReceiptBindingsAgainstFacts } from "./effect-receipt-binding.js";
import type { CoreMindEvent } from "./events.js";
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
      "config" | "initialPrompt" | "sessionId" | "approveTool" | "toolDefinitions"
    >,
  ): Promise<CoreMindRuntime>;
}

const original = "原始完整正文🙂";
const malformed = [
  ["数字语法错误", '{"path":"article.md","content":"危险前缀","unused":.5}'],
  ["最终字符串截断", '{"path":"article.md","content":"被截断'],
  ["最终对象缺少闭括号", '{"path":"article.md","content":"缺少末括号"'],
  ["最终字段缺少值", '{"path":"article.md","content":"未完成末字段","unused":'],
] as const;

describe("最终工具参数的完整性与权限", () => {
  it.for(malformed)("%s 不可执行已解析出的前缀", async ([_name, raw], context) => {
    await withHttp(
      context,
      (_request, ordinal) => (ordinal === 1 ? writeCall(raw) : answer("已收到参数错误")),
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: writeConfig(probe.port),
          initialPrompt: "写入 article.md",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(probe.requests).toHaveLength(2);
        expect(readFileSync(target, "utf8")).toBe(original);
        expect(approve).not.toHaveBeenCalled();
        const events = result.trace.map((entry) => entry.event);
        expect(validateEffectReceiptBindingsAgainstFacts(result.runId, events)).toEqual([
          expect.objectContaining({
            status: "not_started",
            provenance: "bound",
            binding: expect.objectContaining({
              runId: result.runId,
              agent: "main",
              tool: "write",
              callId: "call-write",
            }),
          }),
        ]);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "tool_lifecycle",
            callId: "call-write",
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
        expect(result.trace.map((entry) => entry.event)).toContainEqual(
          expect.objectContaining({
            type: "tool_result",
            callId: "call-write",
            isError: true,
          }),
        );
        expect(
          result.trace.some(
            ({ event }) =>
              event.type === "checkpoint_created" ||
              (event.type === "tool_lifecycle" &&
                event.resolution.phase === "executing" &&
                event.resolution.status === "completed"),
          ),
        ).toBe(false);
        const reply = probe.requests[1]!.messages.find((message) => message.role === "tool");
        expect(reply?.tool_call_id).toBe("call-write");
        expect(messageText(reply)).toContain(raw);
        // 模型收到工具错误后可以正常答复，不把安全拒绝误写成一律 Run 失败。
        expect(result.outcome.status).toBe("succeeded");
      },
      2,
    );
  });

  it.for([
    ["合法 JSON", '{"path":"article.md","content":"完整新正文"}', "完整新正文"],
    [
      "可修复的字符串转义",
      String.raw`{"path":"article.md","content":"\usepackage{x}"}`,
      String.raw`\usepackage{x}`,
    ],
  ])("%s 经过真实审批与 Registry 后写入完整正文", async ([_name, raw, expected], context) => {
    await withHttp(
      context,
      (_request, ordinal) => (ordinal === 1 ? writeCall(raw!) : answer("完成")),
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: writeConfig(probe.port),
          initialPrompt: "写入 article.md",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome.status).toBe("succeeded");
        expect(probe.requests).toHaveLength(2);
        expect(approve).toHaveBeenCalledOnce();
        expect(readFileSync(target, "utf8")).toBe(expected);
        expect(result.trace.map((entry) => entry.event)).toContainEqual(
          expect.objectContaining({
            type: "tool_result",
            callId: "call-write",
            isError: false,
          }),
        );
        expect(result.trace.some(({ event }) => event.type === "checkpoint_created")).toBe(true);
        expect(
          result.trace.some(
            ({ event }) =>
              event.type === "tool_lifecycle" &&
              event.resolution.phase === "executing" &&
              event.resolution.status === "completed",
          ),
        ).toBe(true);
      },
      2,
    );
  });

  it("合法参数也不能绕过真实工具审批拒绝", async (context) => {
    const raw = '{"path":"article.md","content":"不得写入"}';
    await withHttp(
      context,
      () => writeCall(raw),
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "deny" as const);
        const runtime = await probe.create({
          config: writeConfig(probe.port),
          initialPrompt: "写入 article.md",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome).toMatchObject({
          status: "paused",
          finishReason: "tool_approval_denied",
        });
        expect(approve).toHaveBeenCalledOnce();
        expect(probe.requests).toHaveLength(1);
        expect(readFileSync(target, "utf8")).toBe(original);
        expect(
          result.trace.some(
            ({ event }) =>
              event.type === "checkpoint_created" ||
              (event.type === "tool_lifecycle" &&
                event.resolution.phase === "executing" &&
                event.resolution.status === "completed"),
          ),
        ).toBe(false);
      },
      1,
    );
  });
});

describe("恢复历史在模型请求中的思考语义", () => {
  const thinking = "HISTORY_THINKING_CANARY";
  const visibleAnswer = "HISTORY_VISIBLE_ANSWER_CANARY";
  it.for([
    ["同模型", "history-a", "old-model", true],
    ["切换模型", "history-a", "new-model", false],
    ["切换 Provider", "history-b", "old-model", false],
  ] as const)(
    "%s 保留普通回答并仅重放合法思考",
    async ([_name, providerId, modelId, keepThinking], context) => {
      await withHttp(
        context,
        (_request, ordinal) =>
          ordinal === 1
            ? [
                {
                  id: "history",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", reasoning_content: thinking },
                      finish_reason: null,
                    },
                  ],
                },
                {
                  id: "history",
                  choices: [{ index: 0, delta: { content: visibleAnswer }, finish_reason: null }],
                },
                { id: "history", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
              ]
            : answer("继续完成"),
        async (probe) => {
          const base = config(probe.port);
          const firstConfig = validateConfig({
            ...base,
            provider: {
              ...base.provider,
              id: "history-a",
              model: "old-model",
              thinkingFormat: "qwen",
            },
            session: { enabled: true, compact: false },
          });
          const first = await probe.create({
            config: firstConfig,
            initialPrompt: "旧问题",
            sessionId: "thinking-history",
          });
          const firstResult = await first.run();
          expect(firstResult.outcome.status).toBe("succeeded");
          expect(await first.waitForQuiescence()).toBe(true);
          expect(firstResult.sessionFile).toBeTypeOf("string");
          const sessionFile = firstResult.sessionFile!;
          const prefix = readFileSync(sessionFile);
          expect(prefix.toString("utf8")).toContain(thinking);
          expect(prefix.toString("utf8")).toContain(visibleAnswer);
          const second = await probe.create({
            config: validateConfig({
              ...firstConfig,
              provider: { ...firstConfig.provider, id: providerId, model: modelId },
            }),
            initialPrompt: "继续",
            sessionId: "thinking-history",
          });
          expect(second.resumedContextLength).toBeGreaterThan(0);
          const secondResult = await second.run();
          expect(secondResult.outcome.status).toBe("succeeded");
          expect(await second.waitForQuiescence()).toBe(true);
          expect(probe.requests).toHaveLength(2);
          expect(probe.requests[1]!.model).toBe(modelId);
          const prior = probe.requests[1]!.messages.find(
            (message) =>
              message.role === "assistant" && messageText(message).includes(visibleAnswer),
          );
          expect(prior).toBeDefined();
          expect(messageText(prior)).toBe(visibleAnswer);
          if (keepThinking) expect(prior?.reasoning_content).toBe(thinking);
          else expect(JSON.stringify(probe.requests[1])).not.toContain(thinking);
          // 过滤只影响请求视图，原始会话事实不能被删除或重写。
          expect(readFileSync(sessionFile).subarray(0, prefix.length)).toEqual(prefix);
        },
        2,
      );
    },
  );
});

describe("Loop 对无状态流内错误的有界重试", () => {
  const transientMessages = [
    "Unable to forward upstream stream",
    "The service is temporarily unavailable",
  ];
  it.for(transientMessages)("%s 在纯读后仍允许有界重试", async (message, context) => {
    await withHttp(
      context,
      (_request, ordinal) => {
        if (ordinal === 2) return [{ error: { message } }];
        if (ordinal === 1 || ordinal === 3) {
          return [
            {
              id: `read-${ordinal}`,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: ordinal === 1 ? "call-read" : "call-retried-read",
                        type: "function",
                        function: { name: "read", arguments: '{"path":"article.md"}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: `read-${ordinal}`,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            },
          ];
        }
        return answer(ordinal === 4 ? "candidate-after-read" : "PASS");
      },
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: validateConfig({
            ...loopConfig(probe.port),
            tools: [{ id: "read" }],
            permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
          }),
          initialPrompt: "读取文件并完成任务",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome.status).toBe("succeeded");
        expect(probe.requests).toHaveLength(5);
        expect(approve).toHaveBeenCalledTimes(2);
        expect(
          messageText(probe.requests[1]!.messages.find((entry) => entry.role === "tool")),
        ).toContain(original);
        expect(
          messageText(probe.requests[3]!.messages.find((entry) => entry.role === "tool")),
        ).toContain(original);
        expect(JSON.stringify(probe.requests[4])).toContain("REVIEWER_HTTP_SENTINEL");
        expect(readFileSync(target, "utf8")).toBe(original);
        const events = result.trace.map((entry) => entry.event);
        const capabilities = events.filter((event) => event.type === "capability_resolved");
        expect(capabilities).toHaveLength(2);
        expect(capabilities.every((event) => event.capability.effect === "none")).toBe(true);
        expect(validateEffectReceiptBindingsAgainstFacts(result.runId, events)).toHaveLength(2);
        expect(events.filter((event) => event.type === "retry")).toEqual([
          expect.objectContaining({ scope: "provider", attempt: 1 }),
        ]);
      },
      5,
    );
  });

  it("maxRetries=0 不重启已有效果的步骤，保留原失败分类", async (context) => {
    await withHttp(
      context,
      (_request, ordinal) =>
        ordinal === 1
          ? writeCall('{"path":"article.md","content":"ONLY_EFFECT"}')
          : [{ error: { message: "The service is temporarily unavailable" } }],
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const base = loopConfig(probe.port);
        const runtime = await probe.create({
          config: validateConfig({
            ...base,
            runtime: { ...base.runtime, maxRetries: 0 },
            tools: [{ id: "write" }],
            permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
          }),
          initialPrompt: "执行一次写入",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(result.outcome).toMatchObject({
          status: "failed",
          error: { code: "provider_transient" },
        });
        expect(readFileSync(target, "utf8")).toBe("ONLY_EFFECT");
        expect(probe.requests).toHaveLength(2);
        expect(approve).toHaveBeenCalledOnce();
        expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
      },
      2,
    );
  });

  it.for(transientMessages)("%s 在已有工具效果后暂停，不重新执行步骤", async (message, context) => {
    await withHttp(
      context,
      (_request, ordinal) => {
        if (ordinal === 1) return writeCall('{"path":"article.md","content":"FIRST_EFFECT"}');
        if (ordinal === 2) return [{ error: { message } }];
        // 旧实现允许到达这里；使用新 Call 身份，不能靠重复 Call 冲突制造假安全。
        if (ordinal === 3)
          return writeCall(
            '{"path":"article.md","content":"REPLAYED_EFFECT"}',
            "call-replayed-write",
          );
        return answer(ordinal === 4 ? "candidate-after-replay" : "PASS");
      },
      async (probe) => {
        const target = path.join(probe.directory, "article.md");
        writeFileSync(target, original, "utf8");
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: validateConfig({
            ...loopConfig(probe.port),
            tools: [{ id: "write" }],
            permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
          }),
          initialPrompt: "写文件后完成任务",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        // 此断言放最前，让旧红直接证明真实第二次写入，而非只看到终态不同。
        expect(readFileSync(target, "utf8")).toBe("FIRST_EFFECT");
        expect(approve).toHaveBeenCalledOnce();
        expect(probe.requests).toHaveLength(2);
        expect(JSON.stringify(probe.requests)).not.toContain("REVIEWER_HTTP_SENTINEL");
        expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
        expect(result.outcome).toMatchObject({
          status: "paused",
          finishReason: "unclassified_error",
          error: {
            code: "unclassified_error",
            audit: { originalCode: expect.stringContaining(message) },
          },
        });
        const events = result.trace.map((entry) => entry.event);
        expect(validateEffectReceiptBindingsAgainstFacts(result.runId, events)).toEqual([
          expect.objectContaining({
            status: "committed",
            provenance: "bound",
            binding: expect.objectContaining({
              runId: result.runId,
              agent: "coder",
              stepId: "loop-execute:0",
              tool: "write",
              callId: "call-write",
            }),
          }),
        ]);
        const terminal = (
          await new FileRunStore(path.join(probe.directory, "runs")).read(result.runId)
        ).at(-1);
        expect(terminal).toMatchObject({ kind: "pause", payload: { outcome: result.outcome } });
      },
      5,
    );
  });

  it.for(transientMessages)("%s 一次后恢复只执行一次额外模型请求", async (message, context) => {
    await withHttp(
      context,
      (_request, ordinal) =>
        ordinal === 1 ? [{ error: { message } }] : answer(ordinal === 2 ? "candidate-a" : "PASS"),
      async (probe) => {
        const runtime = await probe.create({
          config: loopConfig(probe.port),
          initialPrompt: "执行任务",
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome.status).toBe("succeeded");
        expect(probe.requests).toHaveLength(3);
        expect(JSON.stringify(probe.requests[0])).toContain("EXECUTOR_HTTP_SENTINEL");
        expect(JSON.stringify(probe.requests[1])).toContain("EXECUTOR_HTTP_SENTINEL");
        expect(JSON.stringify(probe.requests[2])).toContain("REVIEWER_HTTP_SENTINEL");
        expect(
          result.trace.filter(({ event }) => event.type === "retry").map(({ event }) => event),
        ).toEqual([expect.objectContaining({ scope: "provider", attempt: 1 })]);
      },
      3,
    );
  });

  it.for(transientMessages)("%s 持续出现时达到重试上限，不进入验证", async (message, context) => {
    await withHttp(
      context,
      () => [{ error: { message } }],
      async (probe) => {
        const runtime = await probe.create({
          config: loopConfig(probe.port),
          initialPrompt: "执行任务",
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(result.outcome.status).toBe("failed");
        expect(probe.requests).toHaveLength(2);
        expect(JSON.stringify(probe.requests)).not.toContain("REVIEWER_HTTP_SENTINEL");
        expect(
          result.trace.filter(({ event }) => event.type === "retry").map(({ event }) => event),
        ).toEqual([expect.objectContaining({ scope: "provider", attempt: 1 })]);
      },
      2,
    );
  });

  it.for(["insufficient_quota: billing limit reached", "unknown stream failure canary"])(
    "%s 保持人工处置，不重试未知或账单错误",
    async (message, context) => {
      await withHttp(
        context,
        () => [{ error: { message } }],
        async (probe) => {
          const runtime = await probe.create({
            config: loopConfig(probe.port),
            initialPrompt: "执行任务",
          });
          const result = await runtime.run();
          expect(await runtime.waitForQuiescence()).toBe(true);
          expect(result.outcome.status).toBe("paused");
          expect(probe.requests).toHaveLength(1);
          expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
        },
        1,
      );
    },
  );
});

describe("准入前拒绝与真实执行的边界", () => {
  it("真实工具执行后抛错保持 unknown，不能补记成未执行", async (context) => {
    await withHttp(
      context,
      (_request, ordinal) =>
        ordinal === 1
          ? [
              {
                id: "effect",
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: "assistant",
                      tool_calls: [
                        {
                          index: 0,
                          id: "call-effect",
                          type: "function",
                          function: { name: "write_then_fail", arguments: "{}" },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              { id: "effect", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
            ]
          : answer("已收到执行后的工具错误"),
      async (probe) => {
        const marker = path.join(probe.directory, "effect-written.marker");
        const approve = vi.fn(async (_request: { tool: string }) => "allow" as const);
        const runtime = await probe.create({
          config: validateConfig({
            ...config(probe.port),
            tools: [],
            permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
          }),
          toolDefinitions: [
            {
              name: "write_then_fail",
              description: "写入真实副作用后返回预期工具错误",
              parameters: { type: "object", properties: {}, additionalProperties: false },
              effect: { operations: ["external"], reversible: false },
              capability: {
                effect: "external",
                replay: "unknown",
                concurrency: "run_serial",
                checkpoint: "unsupported",
                durability: "critical",
              },
              execute: async () => {
                writeFileSync(marker, "effect-written", "utf8");
                throw Object.assign(new Error("执行后预期失败"), { code: "tool_execution_failed" });
              },
            },
          ],
          initialPrompt: "调用 write_then_fail",
          approveTool: approve,
        });
        const result = await runtime.run();
        expect(await runtime.waitForQuiescence()).toBe(true);
        expect(readFileSync(marker, "utf8")).toBe("effect-written");
        expect(approve).toHaveBeenCalledOnce();
        expect(approve.mock.calls[0]?.[0]).toMatchObject({ tool: "write_then_fail" });
        expect(probe.requests).toHaveLength(2);
        const events = result.trace.map((entry) => entry.event);
        const receipts = events
          .filter((event) => event.type === "effect_receipt")
          .filter((event) => event.callId === "call-effect");
        expect(receipts.map((event) => event.status)).toEqual(["started", "unknown"]);
        expect(receipts).toEqual([
          expect.objectContaining({
            binding: expect.objectContaining({ tool: "write_then_fail", callId: "call-effect" }),
          }),
          expect.objectContaining({
            binding: expect.objectContaining({ tool: "write_then_fail", callId: "call-effect" }),
          }),
        ]);
        const lifecycle = events.filter(
          (event) => event.type === "tool_lifecycle" && event.callId === "call-effect",
        );
        expect(lifecycle).toContainEqual(
          expect.objectContaining({
            resolution: { phase: "executing", status: "completed" },
          }),
        );
        expect(lifecycle).toContainEqual(
          expect.objectContaining({
            resolution: expect.objectContaining({
              phase: "observed",
              status: "completed",
              result: expect.objectContaining({
                executionOutcome: "threw",
                effectState: "unknown",
              }),
            }),
          }),
        );
        expect(lifecycle).toContainEqual(
          expect.objectContaining({
            resolution: expect.objectContaining({ phase: "terminal", status: "completed" }),
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "checkpoint_created",
            tool: "write_then_fail",
            reversible: false,
          }),
        );
        const reply = probe.requests[1]!.messages.find((message) => message.role === "tool");
        expect(reply?.tool_call_id).toBe("call-effect");
        expect(messageText(reply)).toContain("执行后预期失败");
        expect(result.outcome.status).toBe("succeeded");
        expect(result.transcript).toBe("已收到执行后的工具错误");
      },
      2,
    );
  });

  it.for(["无start", "错名end"] as const)("%s 不能补造准入前未执行前缀", async (mode, context) => {
    await withHttp(
      context,
      () => answer("不得发起模型请求"),
      async (probe) => {
        const approve = vi.fn(async () => "allow" as const);
        const runtime = await probe.create({
          config: writeConfig(probe.port),
          initialPrompt: "只验证伪造结束事件失败关闭",
          approveTool: approve,
        });
        const builders = (
          runtime as unknown as {
            driverBuilders: Map<
              string,
              (input: {
                onEvent: (event: CoreMindEvent) => void;
                harness?: AgentDriverHarness;
              }) => AgentDriver
            >;
          }
        ).driverBuilders;
        builders.set(
          "main",
          ({ harness, onEvent }) =>
            new FakeAgentDriver({
              script: [{ type: "assistant_message", text: "不会作为成功结果" }],
              onObservation: (observation) => {
                harness?.onObservation?.(observation);
                if (observation.type === "agent_start")
                  onEvent({ type: "agent_start", agent: "main" });
                if (observation.type === "agent_end") onEvent({ type: "agent_end", agent: "main" });
                if (observation.type !== "turn_end") return;
                // Fake 自身的 finally 仍须收敛 running，避免用未退出驱动掩盖绑定拒绝。
                const callId = "forged-end";
                if (mode === "错名end") {
                  const call = {
                    callId,
                    tool: "write",
                    args: { path: "never-created.txt", content: "不得执行" },
                  };
                  harness?.onObservation?.({ type: "tool_execution_start", call });
                  onEvent({
                    type: "tool_call",
                    agent: "main",
                    tool: call.tool,
                    callId,
                    args: call.args,
                  });
                }
                harness?.onObservation?.({
                  type: "tool_execution_end",
                  call: { callId, tool: "read", args: {} },
                  result: { content: [{ type: "text", text: "伪造拒绝" }], details: {} },
                  isError: true,
                });
                onEvent({
                  type: "tool_result",
                  agent: "main",
                  tool: "read",
                  callId,
                  isError: true,
                });
              },
            }),
        );
        const result = await runtime.run();
        expect(result.outcome).toMatchObject({
          status: "failed",
          error: { code: "effect_receipt_conflict" },
        });
        expect(approve).not.toHaveBeenCalled();
        expect(probe.requests).toHaveLength(0);
        const events = result.trace.map(({ event }) => event);
        expect(
          events.some(
            (event) => event.type === "capability_resolved" && event.callId === "forged-end",
          ),
        ).toBe(false);
        expect(
          events.some((event) => event.type === "tool_lifecycle" && event.callId === "forged-end"),
        ).toBe(false);
        expect(
          events.some((event) => event.type === "effect_receipt" && event.callId === "forged-end"),
        ).toBe(false);
        expect(events.some((event) => event.type === "checkpoint_created")).toBe(false);
      },
      0,
    );
  });
});

function config(port: number): CoreMindConfig {
  return validateConfig({
    schemaVersion: 2,
    name: "模型请求回归",
    defaultAgent: "main",
    provider: {
      id: "local-probe",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "probe-model",
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents: { main: { systemPrompt: "按要求执行" } },
    runtime: { maxTurns: 6, maxRetries: 0, runTimeoutMs: 10_000 },
  });
}

function writeConfig(port: number): CoreMindConfig {
  return validateConfig({
    ...config(port),
    tools: [{ id: "write" }],
    permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
  });
}

function loopConfig(port: number): CoreMindConfig {
  const { defaultAgent: _defaultAgent, ...base } = config(port);
  return validateConfig({
    ...base,
    agents: {
      coder: { systemPrompt: "EXECUTOR_HTTP_SENTINEL" },
      reviewer: { systemPrompt: "REVIEWER_HTTP_SENTINEL" },
    },
    runtime: { ...base.runtime, maxRetries: 1 },
    loop: {
      execute: { agent: "coder", input: "执行 {{prompt}}" },
      verify: { agent: "reviewer", input: "验证 {{candidate.text}}", passIf: "{{text}} == PASS" },
      repair: { agent: "coder", input: "根据 {{verification.text}} 修复" },
      maxIterations: 1,
      maxRepairs: 0,
      maxRepeatedAction: 3,
      onFailure: "repair",
      onExhausted: "fail",
    },
  });
}

function writeCall(raw: string, callId = "call-write"): unknown[] {
  return [
    {
      id: "tool",
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
                function: { name: "write", arguments: raw },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    // 最终正常结束为 tool_calls，不能借 length 或传输中断的既有保护通过。
    { id: "tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
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

it("Loop 的 Child 已写入后，父流错误不得重新委派执行步骤", async (context) => {
  let parentRequests = 0;
  let childRequests = 0;
  let reviewerRequests = 0;
  await withHttp(
    context,
    (request) => {
      if (request.model === "child-model") {
        childRequests++;
        if (childRequests === 1 || childRequests === 3) {
          return writeCall(
            JSON.stringify({
              path: "article.md",
              content: childRequests === 1 ? "FIRST_CHILD_EFFECT" : "REPLAYED_CHILD_EFFECT",
            }),
          );
        }
        return answer("子级已完成真实写入");
      }
      if (JSON.stringify(request.messages).includes("REVIEWER_HTTP_SENTINEL")) {
        reviewerRequests++;
        return answer("PASS");
      }
      parentRequests++;
      if (parentRequests === 2)
        return [{ error: { message: "Unable to forward upstream stream" } }];
      if (parentRequests === 1 || parentRequests === 3) {
        return [
          {
            id: "delegate",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: parentRequests === 1 ? "delegate-first" : "delegate-retried",
                      type: "function",
                      function: {
                        name: "delegate",
                        arguments: JSON.stringify({
                          target: "worker",
                          task: "使用write写入article.md，再报告完成",
                          references: [],
                          limits: { maxDepth: 1, maxActiveChildren: 0, descendants: 0 },
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "delegate", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ];
      }
      return answer("父任务候选");
    },
    async (probe) => {
      const target = path.join(probe.directory, "article.md");
      writeFileSync(target, original, "utf8");
      const approve = vi.fn(async () => "allow" as const);
      const base = loopConfig(probe.port);
      const runtime = await probe.create({
        config: validateConfig({
          ...base,
          tools: [],
          agents: {
            ...base.agents,
            coder: {
              ...base.agents.coder,
              tools: [{ id: "write" }],
              delegation: {
                // 父预算明确允许两次新委派，不能让descendants不足掩盖第二次真实写入。
                budget: {
                  tokens: 4_000,
                  toolCalls: 2,
                  costUsd: 1,
                  wallTimeMs: 8_000,
                  steps: 4,
                  descendants: 2,
                },
                limits: { maxDepth: 1, maxActiveChildren: 1, maxDescendants: 2 },
                targets: {
                  worker: {
                    budget: {
                      tokens: 2_000,
                      toolCalls: 1,
                      costUsd: 0.5,
                      wallTimeMs: 4_000,
                      steps: 2,
                      descendants: 0,
                    },
                  },
                },
              },
            },
            worker: {
              systemPrompt: "CHILD_HTTP_SENTINEL",
              model: "child-model",
              tools: [{ id: "write" }],
            },
          },
          runtime: {
            ...base.runtime,
            maxSteps: 8,
            maxToolCalls: 8,
            maxTokens: 8_000,
            maxCostUsd: 2,
          },
          permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
        }),
        initialPrompt: "通过worker完成写入后返回候选",
        approveTool: approve,
      });
      const result = await runtime.run();
      // 首断言直接证明旧实现真的重写了文件，不依赖终态差异或预算先行拒绝。
      expect(readFileSync(target, "utf8")).toBe("FIRST_CHILD_EFFECT");
      expect(await runtime.waitForQuiescence()).toBe(true);
      expect(parentRequests).toBe(2);
      expect(childRequests).toBe(2);
      expect(reviewerRequests).toBe(0);
      expect(probe.requests).toHaveLength(4);
      expect(approve).toHaveBeenCalledTimes(2);
      expect(result.outcome).toMatchObject({
        status: "paused",
        error: { code: "unclassified_error" },
      });
      expect(result.outcome.error?.message).toContain("禁止整步重试");
      expect(result.trace.some(({ event }) => event.type === "retry")).toBe(false);
      expect(result.childRuns?.nodes).toHaveLength(1);
      expect(result.childRuns?.nodes[0]).toMatchObject({
        status: "joined",
        outcome: { status: "succeeded" },
        result: {
          recovery: { effectState: "committed", quiescent: true, executionOwnership: "released" },
        },
      });
      const events = result.trace.map((entry) => entry.event);
      expect(validateEffectReceiptBindingsAgainstFacts(result.runId, events)).toEqual([
        expect.objectContaining({
          status: "committed",
          provenance: "bound",
          binding: expect.objectContaining({ tool: "delegate" }),
        }),
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "capability_resolved",
          tool: "delegate",
          capability: expect.objectContaining({ effect: "none" }),
        }),
      );
    },
    // 旧实现有机会完成第二次真实Child写入和后续验证，不能在HTTP夹具中提前挡住红例。
    9,
  );
});
