import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { TurnTracker } from "./turn-tracker.js";

describe("TurnTracker：Turn 身份分配（规格 02）", () => {
  it("同名并行步骤与迟到工具结果保留各自 Turn", () => {
    const tracker = new TurnTracker();
    const first = tracker.withTurnId({ type: "agent_start", agent: "main", stepId: "a" });
    tracker.withTurnId({
      type: "tool_call",
      agent: "main",
      stepId: "a",
      tool: "read",
      callId: "call-a",
      args: {},
    });
    tracker.withTurnId({ type: "agent_start", agent: "main", stepId: "b" });
    tracker.withTurnId({ type: "agent_end", agent: "main", stepId: "b" });
    const result = tracker.withTurnId({
      type: "tool_result",
      agent: "main",
      stepId: "a",
      tool: "read",
      callId: "call-a",
      isError: false,
    });
    expect(result.turnId).toBe(first.turnId);
  });
  it("agent_start 开启 Turn，turn_end 带同一 TurnId 并关闭", () => {
    const tracker = new TurnTracker();
    const start = tracker.withTurnId({ type: "agent_start", agent: "coder" });
    const end = tracker.withTurnId({ type: "turn_end", agent: "coder" });
    expect(start.turnId).toBeDefined();
    expect(end.turnId).toBe(start.turnId);
  });

  it("turn 之后的工具执行归属刚结束的 Turn", () => {
    const tracker = new TurnTracker();
    const start = tracker.withTurnId({ type: "agent_start", agent: "coder" });
    const end = tracker.withTurnId({ type: "turn_end", agent: "coder" });
    const call = tracker.withTurnId({
      type: "tool_call",
      agent: "coder",
      tool: "read",
      args: {},
      callId: "call-1",
    });
    const result = tracker.withTurnId({
      type: "tool_result",
      agent: "coder",
      tool: "read",
      isError: false,
      callId: "call-1",
    });
    const receipt = tracker.withTurnId({
      type: "effect_receipt",
      idempotencyKey: "run:call-1",
      tool: "read",
      status: "committed",
    });
    expect(call.turnId).toBe(start.turnId);
    expect(result.turnId).toBe(start.turnId);
    expect(receipt.turnId).toBe(start.turnId);
    expect(end.turnId).toBe(start.turnId);
  });

  it("text_delta 在 turn_end 之后开启新 Turn", () => {
    const tracker = new TurnTracker();
    tracker.withTurnId({ type: "agent_start", agent: "coder" });
    const first = tracker.withTurnId({ type: "turn_end", agent: "coder" });
    tracker.withTurnId({ type: "text_delta", agent: "coder", delta: "第二回合" });
    const second = tracker.withTurnId({ type: "turn_end", agent: "coder" });
    expect(second.turnId).toBeDefined();
    expect(second.turnId).not.toBe(first.turnId);
  });

  it("agent_end 带最近 TurnId 并清理状态", () => {
    const tracker = new TurnTracker();
    const start = tracker.withTurnId({ type: "agent_start", agent: "coder" });
    const end = tracker.withTurnId({ type: "agent_end", agent: "coder" });
    expect(end.turnId).toBe(start.turnId);
    // 清理后下一个 agent_start 开启全新 Turn
    const restart = tracker.withTurnId({ type: "agent_start", agent: "coder" });
    expect(restart.turnId).not.toBe(start.turnId);
  });

  it("无关事件原样返回", () => {
    const tracker = new TurnTracker();
    const event: CoreMindEvent = { type: "error", message: "boom", fatal: true };
    expect(tracker.withTurnId(event)).toBe(event);
  });
});
