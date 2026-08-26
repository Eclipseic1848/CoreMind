import { describe, expect, it } from "vitest";
import type { AgentDriverTurnObservation } from "./agent-driver.js";
import { RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import type { CoreMindEvent } from "./events.js";

describe("RunBudgetController", () => {
  it("maxToolCalls=0 时第一次调用即触发硬失败", () => {
    const events: CoreMindEvent[] = [];
    const budget = new RunBudgetController(resolveRuntimeLimits({ maxToolCalls: 0 }, {}), (event) =>
      events.push(event),
    );

    expect(budget.beforeToolCall()).toMatchObject({ block: true });
    expect(() => budget.throwIfExceeded()).toThrow("工具调用次数超过上限");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "budget_exceeded", dimension: "toolCalls" }),
    );
  });

  it("有后续工具轮次时在 maxTurns 边界停止", () => {
    const budget = new RunBudgetController(resolveRuntimeLimits({ maxTurns: 1 }, {}), () => {});
    const shouldAbort = budget.observeAgentEvent(
      turnEndEvent({
        totalTokens: 1,
        cost: 0,
        withToolCall: true,
      }),
    );

    expect(shouldAbort).toBe(true);
    expect(budget.violation?.dimension).toBe("turns");
  });

  it("累加 Provider 报告的 Token 和费用并执行预算", () => {
    const budget = new RunBudgetController(
      resolveRuntimeLimits({ maxTokens: 10, maxCostUsd: 0.01 }, {}),
      () => {},
    );

    budget.observeAgentEvent(turnEndEvent({ totalTokens: 11, cost: 0.02 }));

    expect(budget.violation?.dimension).toBe("tokens");
  });

  it("恢复已有 Trace 计数后继续执行同一预算", () => {
    const budget = new RunBudgetController(resolveRuntimeLimits({ maxToolCalls: 1 }, {}), () => {});
    budget.restore({ type: "tool_call", agent: "main", tool: "read", args: {} });

    expect(budget.beforeToolCall()).toMatchObject({ block: true });
    expect(budget.violation?.dimension).toBe("toolCalls");
  });
});

function turnEndEvent(options: {
  totalTokens: number;
  cost: number;
  withToolCall?: boolean;
}): AgentDriverTurnObservation {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: options.withToolCall
        ? [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]
        : [{ type: "text", text: "完成" }],
      stopReason: options.withToolCall ? "toolUse" : "stop",
      timestamp: Date.now(),
    },
    totalTokens: options.totalTokens,
    contextTokens: options.totalTokens,
    costUsd: options.cost,
    requestsAnotherTurn: options.withToolCall ?? false,
    contextOverflow: false,
  };
}
