import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { type AgentDriver, type AgentDriverObservation, FakeAgentDriver } from "./agent-driver.js";
import { buildAgentDriver } from "./agent-factory.js";

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
    driver.queueControl({ type: "steering", message: "先检查测试" });
    driver.queueControl({ type: "follow_up", message: "再汇总风险" });

    await driver.prompt("修复问题");

    expect(
      driver
        .messages()
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(["修复问题", "先检查测试", "再汇总风险"]);
    expect(driver.status().queuedControls).toBe(0);
  });
});
