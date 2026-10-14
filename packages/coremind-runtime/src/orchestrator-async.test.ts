import { describe, expect, it, vi } from "vitest";
import { FakeAgentDriver } from "./agent-driver.js";
import { Orchestrator } from "./orchestrator.js";

describe("工作流的异步工具准备", () => {
  it("等待当前步骤的工厂完成后才执行真实 Driver", async () => {
    const agent = new FakeAgentDriver({ script: [{ type: "assistant_message", text: "已准备" }] });
    const orchestrator = new Orchestrator(
      [{ id: "prepared", type: "prompt", agent: "main", input: "原始输入", saveAs: "result" }],
      { createAgent: async () => agent, events: () => undefined },
    );
    expect((await orchestrator.run()).get("result")?.text).toBe("已准备");
    expect(agent.messages()[0]?.content).toBe("原始输入");
  });

  it("步骤期限包含异步准备，取消后迟到工厂不能再执行模型", async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentDriver({
      script: [{ type: "assistant_message", text: "不应执行" }],
    });
    const prompt = vi.spyOn(agent, "prompt");
    let release!: () => void;
    let preparationSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orchestrator = new Orchestrator(
      [{ id: "preparing", type: "prompt", agent: "main", input: "原始输入" }],
      {
        createAgent: async (_name, _stepId, signal) => {
          preparationSignal = signal;
          await gate;
          return agent;
        },
        events: () => undefined,
        stepTimeoutMs: 10,
      },
    );
    try {
      const outcome = orchestrator.run().then(
        () => ({ error: undefined }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect((await outcome).error).toMatchObject({ code: "step_timeout" });
      expect(preparationSignal?.aborted).toBe(true);
      release();
      await vi.runAllTimersAsync();
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
    }
  });
});
