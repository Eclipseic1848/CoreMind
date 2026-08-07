import { describe, expect, it } from "vitest";
import type { CoreMindEvent } from "./events.js";
import { analyzeRun, formatQuality } from "./quality.js";

describe("analyzeRun（质量统计）", () => {
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
    const q = analyzeRun(events, [], 1500, 42);
    expect(q.steps).toEqual({ total: 2, ok: 1, failed: 1 });
    expect(q.tools).toEqual({ total: 2, failed: 1 });
    expect(q.elapsedMs).toBe(1500);
    expect(q.outputChars).toBe(42);
    expect(q.tokens).toBeUndefined();
  });

  it("从 assistant usage 汇总 token（复用上游计算）", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        content: [],
        usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "m2",
        role: "assistant",
        content: [],
        usage: { input: 30, output: 20, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    const q = analyzeRun([], messages, 0, 0);
    expect(q.tokens).toBe(200);
  });

  it("formatQuality 生成可读摘要", () => {
    const q = analyzeRun(
      [
        { type: "step_end", stepId: "s1", ok: true },
        { type: "step_end", stepId: "s2", ok: true },
        { type: "tool_call", agent: "a", tool: "read", args: {} },
        { type: "tool_result", agent: "a", tool: "read", isError: false },
      ],
      [
        {
          id: "m1",
          role: "assistant",
          content: [],
          usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      2500,
      88,
    );
    const text = formatQuality(q);
    expect(text).toContain("2 步骤全部成功");
    expect(text).toContain("工具 1 次调用");
    expect(text).toContain("2.5s");
    expect(text).toContain("tokens");
  });
});
