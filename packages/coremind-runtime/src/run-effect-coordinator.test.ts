import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { RunEffectCoordinator } from "./run-effect-coordinator.js";

describe("RunEffectCoordinator", () => {
  it("审批前拒绝的工具记录为未开始，不制造未知副作用", () => {
    const events: CoreMindEvent[] = [];
    const coordinator = new RunEffectCoordinator("run-1", (event) => events.push(event));

    coordinator.emit({
      type: "tool_call",
      agent: "main",
      tool: "write",
      args: { path: "article.md" },
      callId: "call-1",
    });
    coordinator.emit({
      type: "tool_result",
      agent: "main",
      tool: "write",
      isError: true,
      callId: "call-1",
    });

    expect(events.at(-1)).toMatchObject({
      type: "effect_receipt",
      idempotencyKey: "run-1:call-1",
      status: "not_started",
    });
  });

  it("授权后只在真实开始和完成边界写入收据", () => {
    const events: CoreMindEvent[] = [];
    let now = 10;
    const coordinator = new RunEffectCoordinator(
      "run-1",
      (event) => events.push(event),
      () => now,
    );

    coordinator.emit({
      type: "tool_call",
      agent: "main",
      tool: "write",
      args: {},
      callId: "call-1",
      stepId: "step-1",
    });
    coordinator.markStarted("step-1", "call-1", "write");
    now = 35;
    expect(coordinator.consumeDuration("step-1", "call-1")).toBe(25);
    coordinator.emit({
      type: "tool_result",
      agent: "main",
      tool: "write",
      isError: false,
      callId: "call-1",
      stepId: "step-1",
    });

    expect(events.filter((event) => event.type === "effect_receipt")).toEqual([
      expect.objectContaining({ status: "started" }),
      expect.objectContaining({ status: "committed" }),
    ]);
  });

  it("真实开始后执行错误保守记录为未知副作用", () => {
    const events: CoreMindEvent[] = [];
    const coordinator = new RunEffectCoordinator("run-1", (event) => events.push(event));

    coordinator.markStarted(undefined, "call-1", "bash");
    coordinator.emit({
      type: "tool_result",
      agent: "main",
      tool: "bash",
      isError: true,
      callId: "call-1",
    });

    expect(events.at(-1)).toMatchObject({ type: "effect_receipt", status: "unknown" });
  });
});
