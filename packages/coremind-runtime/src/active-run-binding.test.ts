import { describe, expect, it, vi } from "vitest";
import {
  acceptBoundInputControl,
  type BoundInputControl,
  bindActiveRun,
} from "./active-run-binding.js";
import { ChatSession } from "./chat-session.js";
import type { ControlReceipt } from "./control-inbox.js";
import type { CoreMindRuntime } from "./runtime.js";

function binding(acceptInputControl: (command: BoundInputControl) => Promise<ControlReceipt>) {
  return {
    inspectProjection: async () => undefined,
    executeDelegation: async () => ({ content: [], details: undefined }),
    executeDelegationDisposition: async () => ({ content: [], details: undefined }),
    acceptInputControl,
  };
}

describe("活动运行的输入控制绑定", () => {
  it("未绑定时立即拒绝，不等待以后的一轮", async () => {
    await expect(
      acceptBoundInputControl({}, { type: "steering", message: "继续", controlId: "control" }),
    ).rejects.toMatchObject({ code: "control_unavailable" });
  });

  it("投递固定原闭包，旧解绑和迟到回执不能影响下一轮", async () => {
    const owner = {};
    let finish!: (receipt: ControlReceipt) => void;
    const first = vi.fn(
      () =>
        new Promise<ControlReceipt>((resolve) => {
          finish = resolve;
        }),
    );
    const second = vi.fn(
      async () =>
        ({ schemaVersion: 1, runId: "B", controlId: "b", status: "applied" }) as ControlReceipt,
    );
    const unbind = bindActiveRun(owner, binding(first));
    const pending = acceptBoundInputControl(owner, {
      type: "steering",
      message: "只投原轮",
      controlId: "a",
      runId: "A",
    });
    unbind();
    const unbindSecond = bindActiveRun(owner, binding(second));
    unbind();
    finish({ schemaVersion: 1, runId: "A", controlId: "a", status: "applied" });
    await expect(pending).resolves.toMatchObject({ runId: "A", controlId: "a" });
    expect(first).toHaveBeenCalledExactlyOnceWith({
      type: "steering",
      message: "只投原轮",
      controlId: "a",
      runId: "A",
    });
    expect(second).not.toHaveBeenCalled();
    await expect(
      acceptBoundInputControl(owner, { type: "follow_up", message: "新轮", controlId: "b" }),
    ).resolves.toMatchObject({ runId: "B" });
    unbindSecond();
  });

  it.each(["steer", "followUp"] as const)("%s 只包装现有输入控制并保留重试身份", async (method) => {
    const runtime = {
      hasAgent: () => true,
      initialMessagesFor: () => [],
    } as unknown as CoreMindRuntime;
    const session = new ChatSession(runtime, "main");
    const accept = vi.fn(
      async (command: BoundInputControl) =>
        ({
          schemaVersion: 1,
          runId: "active",
          controlId: command.controlId,
          status: "accepted",
        }) as ControlReceipt,
    );
    const unbind = bindActiveRun(runtime, binding(accept));
    try {
      await expect(
        session[method]("相同文字", { controlId: "retry-id", runId: "active" }),
      ).resolves.toMatchObject({ status: "accepted", controlId: "retry-id" });
      expect(accept).toHaveBeenCalledExactlyOnceWith({
        type: method === "steer" ? "steering" : "follow_up",
        message: "相同文字",
        controlId: "retry-id",
        runId: "active",
      });
    } finally {
      unbind();
    }
  });

  it("活动 AbortController 不能替代实际绑定", async () => {
    let finish!: (value: Awaited<ReturnType<CoreMindRuntime["runAgentTurn"]>>) => void;
    const runtime = {
      hasAgent: () => true,
      initialMessagesFor: () => [],
      runAgentTurn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    } as unknown as CoreMindRuntime;
    const session = new ChatSession(runtime, "main");
    const turn = session.chat("未挂上收件箱的初始化窗口");
    try {
      await expect(session.steer("不能误投后续一轮")).rejects.toMatchObject({
        code: "control_unavailable",
      });
    } finally {
      finish({ transcript: "结束", messages: new Map() } as Awaited<
        ReturnType<CoreMindRuntime["runAgentTurn"]>
      >);
      await turn;
    }
  });
});
