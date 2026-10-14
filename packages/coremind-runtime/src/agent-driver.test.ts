import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { type AgentDriver, type AgentDriverObservation, FakeAgentDriver } from "./agent-driver.js";
import { buildAgentDriver } from "./agent-factory.js";
import type { InputId } from "./input-receipt.js";

describe("AgentDriver contract", () => {
  it("Fake Adapter 通过统一接口流式返回观测与最终消息", async () => {
    const observations: string[] = [];
    const driver: AgentDriver = new FakeAgentDriver({
      script: [
        { type: "text_delta", delta: "修复" },
        { type: "text_delta", delta: "完成" },
        { type: "assistant_message", text: "修复完成" },
      ],
      onObservation: (observation) => observations.push(observation.type),
    });

    await driver.prompt("请修复缺陷");
    await driver.waitForIdle();

    expect(observations).toEqual([
      "agent_start",
      "text_delta",
      "text_delta",
      "turn_end",
      "agent_end",
    ]);
    expect(driver.messages()).toEqual([
      { role: "user", content: "请修复缺陷", timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "修复完成" }],
        stopReason: "stop",
        timestamp: 1,
      },
    ]);
    expect(driver.status()).toEqual({
      running: false,
      pendingToolCalls: 0,
      queuedControls: 0,
    });
  });

  it("Production Adapter 把 P3 生命周期归一化到同一 Driver 接口", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("生产适配完成")]);
    const observations: string[] = [];
    const driver: AgentDriver = buildAgentDriver(
      { systemPrompt: "测试助手" },
      {
        models,
        model: faux.getModel(),
        tools: [],
        agentName: "tester",
        onEvent: () => undefined,
        onObservation: (observation) => observations.push(observation.type),
      },
    );

    await driver.prompt("执行任务");
    await driver.waitForIdle();

    expect(observations).toEqual(["agent_start", "text_delta", "turn_end", "agent_end"]);
    expect(driver.messages().at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
    });
    expect(driver.status()).toEqual({
      running: false,
      pendingToolCalls: 0,
      queuedControls: 0,
    });
  });

  it("Production Adapter 在工具开始与结束观测中保持同一 call 参数", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("echo", { value: "保留参数" }, { id: "call-production" }),
      ]),
      fauxAssistantMessage("完成"),
    ]);
    const observations: AgentDriverObservation[] = [];
    const driver = buildAgentDriver(
      { systemPrompt: "测试助手" },
      {
        models,
        model: faux.getModel(),
        tools: [
          {
            name: "echo",
            label: "echo",
            description: "回显输入",
            parameters: Type.Object({ value: Type.String() }),
            execute: async (_callId, params) => ({
              content: [{ type: "text" as const, text: params.value }],
              details: {},
            }),
          },
        ],
        agentName: "tester",
        onEvent: () => undefined,
        onObservation: (observation) => {
          if (observation.type !== "turn_end") observations.push(observation);
        },
      },
    );

    await driver.prompt("调用工具");
    await driver.waitForIdle();

    expect(
      observations
        .filter(
          (observation) =>
            observation.type === "tool_execution_start" ||
            observation.type === "tool_execution_end",
        )
        .map((observation) => observation.call),
    ).toEqual([
      { callId: "call-production", tool: "echo", args: { value: "保留参数" } },
      { callId: "call-production", tool: "echo", args: { value: "保留参数" } },
    ]);
  });

  it("Fake Adapter 把同一批工具调用交给 CoreMind 的唯一执行回调", async () => {
    const executed: string[] = [];
    const observations: string[] = [];
    const driver: AgentDriver = new FakeAgentDriver({
      script: [
        {
          type: "tool_batch",
          calls: [
            { callId: "call-read", tool: "read", args: { path: "a.txt" } },
            { callId: "call-status", tool: "git_status", args: {} },
          ],
        },
      ],
      executeTool: async (call) => {
        executed.push(call.callId);
        return { content: [{ type: "text", text: call.tool }], details: {} };
      },
      onObservation: (observation) => observations.push(observation.type),
    });

    await driver.prompt("检查工作区");

    expect(executed).toEqual(["call-read", "call-status"]);
    expect(observations).toEqual([
      "agent_start",
      "tool_execution_start",
      "tool_execution_start",
      "tool_execution_end",
      "tool_execution_end",
      "agent_end",
    ]);
    expect(driver.status().pendingToolCalls).toBe(0);
  });

  it("abort 传播到在飞工具并丢弃取消后的迟到结果", async () => {
    let release:
      | ((value: {
          content: [{ type: "text"; text: string }];
          details: Record<string, never>;
        }) => void)
      | undefined;
    let observedSignal: AbortSignal | undefined;
    const observations: string[] = [];
    const driver: AgentDriver = new FakeAgentDriver({
      script: [
        {
          type: "tool_batch",
          calls: [{ callId: "call-late", tool: "bash", args: { command: "slow" } }],
        },
      ],
      executeTool: (_call, signal) => {
        observedSignal = signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      onObservation: (observation) => observations.push(observation.type),
    });

    const running = driver.prompt("执行慢任务");
    await vi.waitFor(() => expect(driver.status().pendingToolCalls).toBe(1));
    driver.abort();
    release?.({ content: [{ type: "text", text: "迟到" }], details: {} });
    await running;

    expect(observedSignal?.aborted).toBe(true);
    expect(observations).not.toContain("tool_execution_end");
    expect(driver.messages().at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
    expect(driver.status()).toEqual({
      running: false,
      pendingToolCalls: 0,
      queuedControls: 0,
    });
  });

  it("steering 与 follow-up 通过 Driver 控制接口在各自语义点注入", async () => {
    const driver: AgentDriver = new FakeAgentDriver({
      script: [{ type: "assistant_message", text: "第一轮" }],
    });
    driver.queueControl({
      inputId: "control:steer" as InputId,
      type: "steering",
      message: "先检查测试",
    });
    driver.queueControl({
      inputId: "control:follow" as InputId,
      type: "follow_up",
      message: "再汇总风险",
    });

    await driver.prompt("修复问题");

    expect(
      driver
        .messages()
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["修复问题", "先检查测试", "再汇总风险"]);
    expect(driver.status().queuedControls).toBe(0);
  });

  it.each(["steering", "follow_up"] as const)(
    "Production Adapter 的 %s 通过原生队列按输入身份消费，同文历史和重投不重复认领",
    async (type) => {
      const models = createModels();
      const faux = fauxProvider();
      models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage("第一轮"),
        fauxAssistantMessage("第二轮"),
        fauxAssistantMessage("第三轮"),
      ]);
      const observations: AgentDriverObservation[] = [];
      const first = { inputId: "control:first" as InputId, type, message: "相同正文" };
      const second = { ...first, inputId: "control:second" as InputId };
      const driver = buildAgentDriver(
        {},
        {
          models,
          model: faux.getModel(),
          tools: [],
          agentName: "main",
          onEvent: () => undefined,
          onObservation: (observation) => observations.push(observation),
        },
      );
      driver.queueControl(first);
      driver.queueControl(first);
      driver.queueControl(second);
      expect(driver.status().queuedControls).toBe(2);
      expect(observations).toEqual([]);
      expect(driver.canAcceptControl()).toBe(true);
      await driver.prompt("相同正文");
      await driver.waitForIdle();
      expect(observations.filter((observation) => observation.type === "control_consumed")).toEqual(
        [
          { type: "control_consumed", inputId: first.inputId },
          { type: "control_consumed", inputId: second.inputId },
        ],
      );
      expect(
        driver
          .messages()
          .filter((message) => message.role === "user")
          .map((message) => message.content),
      ).toEqual([[{ type: "text", text: "相同正文" }], "相同正文", "相同正文"]);
      expect(driver.status().queuedControls).toBe(0);
      expect(driver.canAcceptControl()).toBe(false);
      driver.queueControl(first);
      expect(driver.status().queuedControls).toBe(0);
    },
  );

  it("Production Adapter 结束后晚到控制只由显式清理丢弃一次，不能带入下次 prompt", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("完成"), fauxAssistantMessage("新输入完成")]);
    const observations: AgentDriverObservation[] = [];
    const driver = buildAgentDriver(
      {},
      {
        models,
        model: faux.getModel(),
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        onObservation: (observation) => observations.push(observation),
      },
    );
    await driver.prompt("首输入");
    const previousMessages = [...driver.messages()];
    const late = {
      inputId: "control:late" as InputId,
      type: "follow_up" as const,
      message: "不得泄漏的旧控制",
    };
    expect(driver.canAcceptControl()).toBe(false);
    expect(() => driver.queueControl(late)).not.toThrow();
    expect(driver.status().queuedControls).toBe(1);
    expect(observations.filter((observation) => observation.type === "control_discarded")).toEqual(
      [],
    );
    driver.clearQueuedControls();
    driver.clearQueuedControls();
    driver.queueControl(late);
    expect(driver.status().queuedControls).toBe(0);
    expect(driver.messages()).toEqual(previousMessages);
    expect(observations.filter((observation) => observation.type === "control_discarded")).toEqual([
      { type: "control_discarded", inputId: late.inputId },
    ]);
    await driver.prompt("新输入");
    expect(driver.messages().some((message) => message.content === late.message)).toBe(false);
  });

  it("Production Adapter 的 beforePrompt 阻塞真实请求并允许就绪重放先进入原生队列", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("完成")]);
    const entered = deferred();
    const release = deferred();
    const dispatched = vi.fn();
    const observations: AgentDriverObservation[] = [];
    const inputId = "control:before-prompt" as InputId;
    const driver = buildAgentDriver(
      {},
      {
        models,
        model: faux.getModel(),
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        onObservation: (observation) => observations.push(observation),
        harness: {
          beforePrompt: async () => {
            entered.resolve();
            await release.promise;
            driver.queueControl({ inputId, type: "steering", message: "已持久应用的控制" });
          },
          onModelRequestDispatched: dispatched,
        },
      },
    );
    const running = driver.prompt("首输入");
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("beforePrompt 尚未进入便已结束");
        }),
      ]);
      expect(driver.status().running).toBe(true);
      expect(driver.canAcceptControl()).toBe(true);
      expect(observations).toEqual([]);
      expect(dispatched).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await running;
      await driver.waitForIdle();
    }
    expect(dispatched).toHaveBeenCalledTimes(1);
    expect(observations.filter((observation) => observation.type === "control_consumed")).toEqual([
      { type: "control_consumed", inputId },
    ]);
    expect(driver.messages().some((message) => message.content === "已持久应用的控制")).toBe(true);
  });

  it("beforePrompt 失败也关闭控制准入，下一次 prompt 重开且 agent_end 观测时已关闭", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("完成")]);
    let attempts = 0;
    const admitted: boolean[] = [];
    const ended: boolean[] = [];
    const driver = buildAgentDriver(
      {},
      {
        models,
        model: faux.getModel(),
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        onObservation: (observation) => {
          if (observation.type === "agent_end") ended.push(driver.canAcceptControl());
        },
        harness: {
          beforePrompt: async () => {
            admitted.push(driver.canAcceptControl());
            if (attempts++ === 0) throw new Error("就绪重放失败");
          },
        },
      },
    );
    await expect(driver.prompt("第一次")).rejects.toThrow("就绪重放失败");
    expect(driver.canAcceptControl()).toBe(false);
    expect(driver.status().running).toBe(false);
    expect(driver.messages()).toEqual([]);
    await driver.prompt("第二次");
    expect(admitted).toEqual([true, true]);
    expect(ended).toEqual([false]);
    expect(driver.canAcceptControl()).toBe(false);
  });

  it("agent_end 不把尚未消费的原生 follow-up 计数归零或伪报消费", async () => {
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("本轮停止")]);
    const observations: AgentDriverObservation[] = [];
    const inputId = "control:unconsumed" as InputId;
    const driver = buildAgentDriver(
      {},
      {
        models,
        model: faux.getModel(),
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        onObservation: (observation) => observations.push(observation),
        harness: { shouldStopAfterTurn: () => true },
      },
    );
    driver.queueControl({ inputId, type: "follow_up", message: "仍未消费" });
    await driver.prompt("首输入");
    expect(driver.canAcceptControl()).toBe(false);
    expect(driver.status().queuedControls).toBe(1);
    expect(observations.filter((observation) => observation.type.startsWith("control_"))).toEqual(
      [],
    );
    driver.clearQueuedControls();
    expect(driver.status().queuedControls).toBe(0);
    expect(observations.filter((observation) => observation.type === "control_discarded")).toEqual([
      { type: "control_discarded", inputId },
    ]);
  });

  it("Fake Adapter 取消保留未消费身份，显式清理只丢弃一次", async () => {
    const entered = deferred();
    const release = deferred();
    const observations: AgentDriverObservation[] = [];
    const inputId = "control:fake-cancel" as InputId;
    const driver = new FakeAgentDriver({
      script: [{ type: "tool_batch", calls: [{ callId: "call", tool: "echo", args: {} }] }],
      executeTool: async () => {
        entered.resolve();
        await release.promise;
        return { content: [], details: {} };
      },
      onObservation: (observation) => observations.push(observation),
    });
    const running = driver.prompt("首输入");
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("工具尚未进入便已结束");
        }),
      ]);
      const control = { inputId, type: "follow_up" as const, message: "取消后不得消费" };
      driver.queueControl(control);
      driver.queueControl(control);
      driver.abort();
    } finally {
      release.resolve();
      await running;
    }
    expect(driver.canAcceptControl()).toBe(false);
    expect(driver.status().queuedControls).toBe(1);
    expect(observations.filter((observation) => observation.type === "control_consumed")).toEqual(
      [],
    );
    driver.clearQueuedControls();
    driver.clearQueuedControls();
    expect(observations.filter((observation) => observation.type === "control_discarded")).toEqual([
      { type: "control_discarded", inputId },
    ]);
    expect(driver.status().queuedControls).toBe(0);
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
