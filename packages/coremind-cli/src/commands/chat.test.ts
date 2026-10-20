import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  ChatSession,
  type ChatTurnResult,
  type ControlReceipt,
  type CoreMindEvent,
  CoreMindRuntime,
  type ToolApprovalRequest,
} from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approval.js";
import { renderChatEvent, runReadlineChat } from "./chat.js";

it.each([
  ["/exit", "model"],
  ["!exit", "model"],
  ["/exit", "tool"],
  ["!exit", "tool"],
  ["EOF", "model"],
])("readline %s 在真实 %s 开始后区分取消与 EOF 自然完成，并等待收尾", async (command, stage) => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-readline-exit-"));
  let response: ServerResponse | undefined;
  let requestStarted = false;
  let toolStarted = false;
  let toolSignal: AbortSignal | undefined;
  let toolCleaned = false;
  let releaseTool!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const server = createServer((request, reply) => {
    request.resume();
    response = reply;
    reply.writeHead(200, { "content-type": "text/event-stream" });
    if (stage === "tool") {
      reply.write(
        `data: ${JSON.stringify({ id: "tool", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "wait-call", type: "function", function: { name: "wait_tool", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })}\n\n`,
      );
      reply.end("data: [DONE]\n\n");
    } else {
      reply.write(": 等待取消或自然完成\n\n");
    }
    requestStarted = true;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let session: ChatSession | undefined;
  let running: Promise<void> | undefined;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("本地模型未分配端口");
    const runtime = await CoreMindRuntime.create({
      cwd,
      configDir: cwd,
      env: { COREMIND_TEST_API_KEY: "test-only" },
      config: {
        schemaVersion: 2,
        name: "readline-exit",
        provider: {
          id: "probe",
          model: "probe",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKeyEnv: "COREMIND_TEST_API_KEY",
        },
        agents: { main: {} },
        permissions: { mode: "full" },
        runtime: { maxRetries: 0 },
      },
      toolDefinitions: [
        {
          name: "wait_tool",
          description: "等待取消后完成独立收尾",
          parameters: { type: "object" },
          effect: { operations: ["read"], reversible: true },
          execute: async (_args, { signal }) => {
            toolSignal = signal;
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve(), { once: true });
              toolStarted = true;
            });
            await cleanup;
            toolCleaned = true;
            return { text: "工具已收尾" };
          },
        },
      ],
    });
    session = new ChatSession(runtime, "main");
    const abort = vi.spyOn(session, "abort");
    const chat = session.chat.bind(session);
    let turn: ChatTurnResult | undefined;
    vi.spyOn(session, "chat").mockImplementation(async (message) => {
      turn = await chat(message);
      return turn;
    });
    let completed = false;
    running = runReadlineChat(session, new ApprovalQueue(false), { input, output }).then(() => {
      completed = true;
    });
    input.write("开始真实执行\n");
    await vi.waitFor(() => expect(stage === "tool" ? toolStarted : requestStarted).toBe(true));
    if (command === "EOF") {
      input.end();
      await Promise.resolve();
      expect(abort).not.toHaveBeenCalled();
      expect(completed).toBe(false);
      response!.write(
        `data: ${JSON.stringify({ id: "final", choices: [{ index: 0, delta: { role: "assistant", content: "自然完成" }, finish_reason: "stop" }] })}\n\n`,
      );
      response!.end("data: [DONE]\n\n");
    } else {
      input.write(`${command}\n`);
      await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
      if (stage === "tool") {
        expect(toolSignal?.aborted).toBe(true);
        expect(toolCleaned).toBe(false);
        expect(completed).toBe(false);
        releaseTool();
      }
    }
    await running;
    expect(turn?.run.outcome.status).toBe(command === "EOF" ? "succeeded" : "aborted");
    expect(turn?.text).toBe(command === "EOF" ? "自然完成" : "");
    if (stage === "tool") expect(toolCleaned).toBe(true);
    expect(await runtime.waitForQuiescence()).toBe(true);
  } finally {
    session?.abort();
    releaseTool();
    input.end();
    await running;
    input.destroy();
    output.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(path.dirname(path.resolve(cwd))).toBe(path.resolve(tmpdir()));
    rmSync(cwd, { recursive: true, force: true });
  }
});

it.each(["/exit", "!exit"])("readline 空闲 %s 不发起新对话", async (command) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const session = { chat: vi.fn(), abort: vi.fn() } as unknown as ChatSession;
  const running = runReadlineChat(session, new ApprovalQueue(false), { input, output });
  try {
    input.end(`${command}\n`);
    await running;
    expect(session.chat).not.toHaveBeenCalled();
  } finally {
    input.destroy();
    output.destroy();
  }
});

it.each(["/exit", "!exit"])(
  "readline 审批等待时 %s 拒绝待审批工具并取消当前轮",
  async (command) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const approvals = new ApprovalQueue(true);
    const chat = vi.fn(() => approvals.request(approvalRequest()));
    const abort = vi.fn();
    const running = runReadlineChat({ chat, abort } as unknown as ChatSession, approvals, {
      input,
      output,
    });
    try {
      input.write("开始\n");
      await vi.waitFor(() => expect(approvals.current).toBeDefined());
      input.write(`${command}\n`);
      await running;
      expect(abort).toHaveBeenCalledOnce();
      await expect(chat.mock.results[0]!.value).resolves.toBe("deny");
      expect(approvals.current).toBeUndefined();
    } finally {
      input.end();
      approvals.close();
      await running;
      input.destroy();
      output.destroy();
    }
  },
);

it("readline 在回答未结束时处理取消，并等待退出收尾", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let finish!: () => void;
  const chat = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const abort = vi.fn(() => finish());
  const session = { chat, abort } as unknown as ChatSession;
  const running = runReadlineChat(session, new ApprovalQueue(false), { input, output });
  input.write("hello\n");
  await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
  input.write("second\n/abort\n");
  await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
  expect(chat).toHaveBeenCalledOnce();
  input.end();
  await running;
});

it("取消清空该轮排队审批，后续输入仍能开始新对话", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const approvals = new ApprovalQueue(true);
  const request = (approvalId: string): ToolApprovalRequest => ({
    approvalId,
    runId: "run",
    agent: "main",
    tool: "write",
    args: {},
    argumentsFingerprint: "a".repeat(64),
    risk: "low",
    reason: "测试",
    effect: { operations: ["write"], paths: [], urls: [], reversible: true, declared: true },
  });
  const chat = vi.fn(async () => {
    await Promise.all([approvals.request(request("a")), approvals.request(request("b"))]);
  });
  const session = { chat, abort: vi.fn() } as unknown as ChatSession;
  const running = runReadlineChat(session, approvals, { input, output });
  input.write("first\n");
  await vi.waitFor(() => expect(approvals.current).toBeDefined());
  input.write("/abort\n");
  await vi.waitFor(() => expect(approvals.current).toBeUndefined());
  input.write("second\n");
  await vi.waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
  input.write("/abort\n");
  await vi.waitFor(() => expect(approvals.current).toBeUndefined());
  input.end();
  await running;
});

it.each(["steer", "follow-up"])(
  "readline 审批期间的 /%s 不消费审批，迟到回执不替换草稿",
  async (command) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let printed = "";
    output.on("data", (chunk) => {
      printed += chunk.toString("utf8");
    });
    let finishChat!: () => void;
    let finishControl!: (receipt: ControlReceipt) => void;
    let rejectControl!: (error: Error) => void;
    const firstChat = new Promise<void>((resolve) => {
      finishChat = resolve;
    });
    const response = new Promise<ControlReceipt>((resolve, reject) => {
      finishControl = resolve;
      rejectControl = reject;
    });
    const chat = vi.fn().mockReturnValueOnce(firstChat).mockResolvedValue(undefined);
    const steer = vi.fn(() => response);
    const followUp = vi.fn(() => response);
    const approvals = new ApprovalQueue(true);
    const running = runReadlineChat(
      { chat, steer, followUp, abort: vi.fn() } as unknown as ChatSession,
      approvals,
      { input, output },
    );
    try {
      input.write("开始\n");
      await vi.waitFor(() => expect(chat).toHaveBeenCalledOnce());
      const decision = approvals.request(approvalRequest());
      await vi.waitFor(() => expect(printed).toContain("允许？"));
      input.write(`/${command} y n 仍需原审批\n`);
      await vi.waitFor(() =>
        expect(command === "steer" ? steer : followUp).toHaveBeenCalledWith("y n 仍需原审批"),
      );
      expect(approvals.current?.request.approvalId).toBe("approval-control");
      input.write("y\n保留的新草稿\n不可覆盖的新行\n");
      await expect(decision).resolves.toBe("allow");
      await vi.waitFor(() => expect(printed).toContain("本次输入未保存：不可覆盖的新行"));
      expect(chat).toHaveBeenCalledOnce();
      if (command === "follow-up") rejectControl(new Error("control_unavailable"));
      else finishControl(receipt("applied"));
      await vi.waitFor(() =>
        expect(printed).toContain(
          command === "follow-up"
            ? "控制失败：control_unavailable"
            : "控制 control-original · Run run-original · applied",
        ),
      );
      finishChat();
      await vi.waitFor(() => expect(printed).toContain("草稿待确认：保留的新草稿"));
      expect(chat).toHaveBeenCalledOnce();
      input.write("\n");
      await vi.waitFor(() => expect(chat).toHaveBeenNthCalledWith(2, "保留的新草稿"));
    } finally {
      finishControl(receipt("applied"));
      finishChat();
      input.end();
      await running;
    }
  },
);

it("readline 精确控制命令与五态回执保留身份，空命令不作为审批答案", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk.toString("utf8");
  });
  const statuses = ["accepted", "applied", "rejected", "duplicate", "conflict"] as const;
  const steer = vi.fn();
  for (const status of statuses) steer.mockResolvedValueOnce(receipt(status));
  const approvals = new ApprovalQueue(true);
  const running = runReadlineChat(
    { chat: vi.fn(), abort: vi.fn(), steer, followUp: vi.fn() } as unknown as ChatSession,
    approvals,
    { input, output },
  );
  try {
    const decision = approvals.request(approvalRequest());
    await vi.waitFor(() => expect(printed).toContain("允许？"));
    input.write("/steer\n/follow-up   \n/steering y\n");
    await vi.waitFor(() => expect(printed).toContain("未知命令：/steering y"));
    expect(steer).not.toHaveBeenCalled();
    expect(approvals.current).toBeDefined();
    for (const status of statuses) {
      input.write(`/steer ${status}\n`);
      await vi.waitFor(() => expect(printed).toContain(`Run run-original · ${status}`));
    }
    input.write("n\n");
    await expect(decision).resolves.toBe("deny");
  } finally {
    input.end();
    await running;
  }
});

it("readline 输入消费事实与控制回执独立显示", () => {
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += chunk.toString("utf8");
  });
  const events: CoreMindEvent[] = [
    {
      type: "input_receipt",
      inputId: "control-input",
      status: "pending",
      contentFingerprint: "frozen",
      timestamp: "2026-10-14T00:00:00Z",
    },
    {
      type: "input_claimed",
      inputId: "control-input",
      status: "claimed",
      turnId: "turn-control",
      timestamp: "2026-10-14T00:00:01Z",
    },
    {
      type: "input_completed",
      inputId: "control-input",
      status: "completed",
      timestamp: "2026-10-14T00:00:02Z",
    },
    {
      type: "input_discarded",
      inputId: "other-control",
      status: "discarded",
      timestamp: "2026-10-14T00:00:03Z",
    },
  ];
  for (const event of events) renderChatEvent(event, output);
  expect(printed).toContain("输入 control-input · pending");
  expect(printed).toContain("输入 control-input · claimed · Turn turn-control");
  expect(printed).toContain("输入 control-input · completed");
  expect(printed).toContain("输入 other-control · discarded");
});

function receipt(status: ControlReceipt["status"]): ControlReceipt {
  return { schemaVersion: 1, controlId: "control-original", runId: "run-original", status };
}

function approvalRequest(): ToolApprovalRequest {
  return {
    approvalId: "approval-control",
    runId: "run-original",
    agent: "main",
    tool: "write",
    args: {},
    argumentsFingerprint: "a".repeat(64),
    risk: "high",
    reason: "显式审批",
    effect: { operations: ["write"], paths: [], urls: [], reversible: true, declared: true },
  };
}
