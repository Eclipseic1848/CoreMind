import { PassThrough } from "node:stream";
import type { ChatSession, ControlReceipt, CoreMindEvent, ToolApprovalRequest } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approval.js";
import { renderChatEvent, runReadlineChat } from "./chat.js";

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
