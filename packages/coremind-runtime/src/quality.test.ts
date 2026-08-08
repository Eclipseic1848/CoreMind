import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { analyzeRunMetrics, formatMetrics } from "./result.js";

describe("analyzeRunMetrics（执行指标）", () => {
  it("统计步骤成败与工具失败", () => {
    const events: CoreMindEvent[] = [
      { type: "step_start", stepId: "s1", kind: "prompt" },
      { type: "tool_call", agent: "a", tool: "read", args: {} },
      { type: "tool_result", agent: "a", tool: "read", isError: false },
      { type: "step_end", stepId: "s1", ok: true },
      { type: "step_start", stepId: "s2", kind: "prompt" },
      { type: "tool_call", agent: "a", tool: "bash", args: {} },
      { type: "tool_result", agent: "a", tool: "bash", isError: true },
      { type: "step_end", stepId: "s2", ok: false },
    ];
    const q = analyzeRunMetrics(events, [], 1500, 42);
    expect(q.steps).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(q.toolCalls).toBe(2);
    expect(q.toolFailures).toBe(1);
    expect(q.durationMs).toBe(1500);
    expect(q.outputChars).toBe(42);
    expect(q.tokens).toBeUndefined();
  });

  it("从 assistant usage 汇总 token（复用上游计算）", () => {
    const messages: AgentMessage[] = [assistantMessage(100, 50), assistantMessage(30, 20)];
    const q = analyzeRunMetrics([], messages, 0, 0);
    expect(q.tokens).toBe(200);
  });

  it("恢复运行优先从完整 Trace 汇总 token，避免与当前消息重复计算", () => {
    const q = analyzeRunMetrics(
      [
        { type: "turn_end", agent: "a", tokens: 70, costUsd: 0.01 },
        { type: "turn_end", agent: "a", tokens: 30, costUsd: 0.02 },
      ],
      [assistantMessage(999, 1)],
      0,
      0,
    );

    expect(q.tokens).toBe(100);
    expect(q.costUsd).toBeCloseTo(0.03);
  });

  it("formatMetrics 生成可读摘要", () => {
    const q = analyzeRunMetrics(
      [
        { type: "step_end", stepId: "s1", ok: true },
        { type: "step_end", stepId: "s2", ok: true },
        { type: "tool_call", agent: "a", tool: "read", args: {} },
        { type: "tool_result", agent: "a", tool: "read", isError: false },
      ],
      [assistantMessage(100, 0)],
      2500,
      88,
    );
    const text = formatMetrics(q);
    expect(text).toContain("2 步骤全部成功");
    expect(text).toContain("工具 1 次调用");
    expect(text).toContain("2.5s");
    expect(text).toContain("tokens");
  });
});

function assistantMessage(input: number, output: number): AgentMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
