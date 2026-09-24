import { PassThrough } from "node:stream";
import type { ChatSession, ToolApprovalRequest } from "coremind-ai";
import { expect, it, vi } from "vitest";
import { ApprovalQueue } from "../approval.js";
import { runReadlineChat } from "./chat.js";

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
