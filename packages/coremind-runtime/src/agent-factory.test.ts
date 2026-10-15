import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels, getCurrentTools } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { buildTools } from "coremind-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentDriverContextContract, AgentDriverHarness } from "./agent-driver.js";
import { buildAgent, buildAgentDriver } from "./agent-factory.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { ToolExecutionEngine } from "./tool-call-lifecycle.js";

const temporaryRoots: string[] = [];

describe("按需工具的完整 Adapter 声明帧", () => {
  it("先只声明初始选择，持久门确认后下一真实请求使用同一完整 schema/prefix/执行对象", async () => {
    const { models, model, faux } = makeFauxContext();
    const initial = { names: ["discover_tools"], generation: 0, fingerprint: "a".repeat(64) };
    const installed = {
      names: ["discover_tools", "deferred_read"],
      generation: 1,
      fingerprint: "b".repeat(64),
    };
    let found = false;
    let release!: () => void;
    let prepared = false;
    const durable = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = createReadTool(process.cwd());
    const deferred = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "真实目标结果" }],
      details: {},
    }));
    const tools = [
      {
        ...base,
        name: "discover_tools",
        description: "发现当前允许的工具",
        execute: async () => {
          found = true;
          return {
            content: [{ type: "text" as const, text: "已找到工具，待下一请求声明" }],
            details: {},
          };
        },
      },
      {
        ...base,
        name: "deferred_read",
        description: "仅安装后曝光的完整目标说明",
        execute: deferred,
      },
    ];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("discover_tools", { path: "query" })]),
      fauxAssistantMessage([fauxToolCall("deferred_read", { path: "notes.txt" })]),
      fauxAssistantMessage("完成"),
    ]);
    const requests: Array<Parameters<typeof models.streamSimple>[1]> = [];
    const original = models.streamSimple.bind(models);
    models.streamSimple = ((...args) => {
      requests.push(structuredClone(args[1]));
      return original(...args);
    }) as typeof models.streamSimple;
    let current: AgentDriverContextContract | undefined;
    const budgeted: AgentDriverContextContract[] = [];
    const registerCatalog = vi.fn(
      (_entries: readonly { name: string; description: string; declaration: unknown }[]) => initial,
    );
    const executeTool = vi.fn(async ({ invoke }) => invoke());
    const harness = {
      registerDeclarationCatalog: registerCatalog,
      registerContextContract: (contract: AgentDriverContextContract) => {
        current = contract;
      },
      prepareRequest: async (
        prepare: (selection: typeof initial) => AgentDriverContextContract,
      ) => {
        const selected = found ? installed : initial;
        const contract = prepare(selected);
        if (found && !prepared) {
          prepared = true;
          expect(current?.toolSchemas).toEqual([
            expect.objectContaining({ name: "discover_tools" }),
          ]);
          expect(contract.toolSchemas).toEqual(
            tools.map((tool) => expect.objectContaining({ name: tool.name })),
          );
          await durable;
        }
        return selected;
      },
      transformContext: async (messages) => {
        expect(current).toBeDefined();
        budgeted.push(structuredClone(current!));
        expect(messages.some((message) => message.role === "system")).toBe(false);
        return messages;
      },
      executeTool,
    } as AgentDriverHarness;
    const driver = buildAgentDriver(
      { systemPrompt: "声明帧测试" },
      { models, model, tools, agentName: "main", onEvent: () => {}, harness },
    );
    const running = driver.prompt("先发现再读取");
    try {
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual([
        "discover_tools",
      ]);
      await vi.waitFor(() => expect(prepared).toBe(true));
      expect(requests).toHaveLength(1);
      release();
      await running;
      await driver.waitForIdle();
      expect(registerCatalog).toHaveBeenCalledOnce();
      expect(registerCatalog.mock.calls[0]?.[0]).toEqual(
        tools.map((tool) =>
          expect.objectContaining({
            name: tool.name,
            description: tool.description,
            declaration: expect.objectContaining({ name: tool.name }),
          }),
        ),
      );
      expect(requests).toHaveLength(3);
      for (let index = 0; index < requests.length; index++) {
        const names = index === 0 ? initial.names : installed.names;
        expect(getCurrentTools(requests[index]!.messages).map((tool) => tool.name)).toEqual(names);
        expect(
          requests[index]!.messages.filter((message) => message.role === "system"),
        ).toHaveLength(1);
        expect(budgeted[index]?.toolSchemas).toEqual(getCurrentTools(requests[index]!.messages));
        expect(
          (budgeted[index] as AgentDriverContextContract & { toolDiscovery?: unknown })
            .toolDiscovery,
        ).toEqual({
          generation: index === 0 ? 0 : 1,
          fingerprint: index === 0 ? initial.fingerprint : installed.fingerprint,
        });
        expect(requests[index]!.messages[0]?.content).toBe(budgeted[index]?.stablePrefix);
      }
      expect(driver.messages().some((message) => message.role === "system")).toBe(false);
      expect(deferred).toHaveBeenCalledOnce();
      expect(executeTool).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await running;
    }
  });

  it.each(["durability", "identity"] as const)(
    "请求前 %s 失败保持 typed 原因且真实 Provider 零发送",
    async (failure) => {
      const { models, model, faux } = makeFauxContext();
      faux.setResponses([fauxAssistantMessage("不应发送")]);
      const request = vi.fn(models.streamSimple.bind(models));
      models.streamSimple = request;
      const selection = { names: [], generation: 0, fingerprint: "a".repeat(64) };
      const harness = {
        registerDeclarationCatalog: () => selection,
        prepareRequest: async (
          prepare: (value: typeof selection) => AgentDriverContextContract,
        ) => {
          prepare(selection);
          if (failure === "durability")
            throw new CoreMindError("fact_ledger_poisoned", "固定持久门失败");
          return { ...selection };
        },
      } as AgentDriverHarness;
      const driver = buildAgentDriver(
        {},
        { models, model, tools: [], agentName: "main", onEvent: () => {}, harness },
      );
      await driver.prompt("不能发送");
      await expect(driver.waitForIdle()).rejects.toMatchObject({
        code: failure === "durability" ? "fact_ledger_poisoned" : "tool_capability_conflict",
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFauxContext() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), faux };
}

describe("prompt 成功通知", () => {
  it("真实完成后只通知一次，空闲检查不完成尚未开始的 prompt", async () => {
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([fauxAssistantMessage("第一次完成"), fauxAssistantMessage("第二次完成")]);
    const completed = vi.fn();
    const driver = buildAgentDriver(
      {},
      {
        models,
        model,
        tools: [],
        agentName: "main",
        onEvent: () => {},
        harness: { onPromptCompleted: completed },
      },
    );
    await driver.waitForIdle();
    expect(completed).not.toHaveBeenCalled();
    await driver.prompt("第一次");
    expect(completed).not.toHaveBeenCalled();
    await driver.waitForIdle();
    await driver.waitForIdle();
    expect(completed).toHaveBeenCalledTimes(1);
    await driver.prompt("第二次");
    await driver.waitForIdle();
    expect(completed).toHaveBeenCalledTimes(2);
  });

  it("原生因工具审批拒绝结束后，不把 agent_end 当作成功", async () => {
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })])]);
    const completed = vi.fn();
    const invoke = vi.fn();
    let denied = false;
    const driver = buildAgentDriver(
      {},
      {
        models,
        model,
        tools: [{ ...createReadTool(process.cwd()), execute: invoke }],
        agentName: "main",
        onEvent: () => {},
        harness: {
          onPromptCompleted: completed,
          beforeToolCall: async () => {
            denied = true;
            return { block: true, reason: "未批准" };
          },
          shouldStopAfterTurn: () => denied,
          throwIfDenied: () => {
            if (denied) throw new CoreMindError("loop_paused", "未批准");
          },
        },
      },
    );
    await driver.prompt("读取");
    await expect(driver.waitForIdle()).rejects.toMatchObject({ code: "loop_paused" });
    expect(invoke).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it.each(["error", "aborted"] as const)("Provider 原始 %s 终态不通知成功", async (stopReason) => {
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: "原始失败" })]);
    const completed = vi.fn();
    const driver = buildAgentDriver(
      {},
      {
        models,
        model,
        tools: [],
        agentName: "main",
        onEvent: () => {},
        harness: { onPromptCompleted: completed },
      },
    );
    await driver.prompt("不得误报完成");
    await driver.waitForIdle();
    expect(driver.messages().at(-1)).toMatchObject({ role: "assistant", stopReason });
    expect(completed).not.toHaveBeenCalled();
  });
});

describe("buildAgent（离线 faux 端到端）", () => {
  it("配置 → Agent 连续两次工具调用的结果都回灌后再结束", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-"));
    writeFileSync(path.join(dir, "notes.txt"), "这是测试内容", "utf8");
    writeFileSync(path.join(dir, "notes-2.txt"), "这是第二份测试内容", "utf8");
    const { models, model, faux } = makeFauxContext();
    // 三步响应：连续两次工具调用都完成后再输出最终文本。
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })]),
      fauxAssistantMessage([fauxToolCall("read", { path: "notes-2.txt" })]),
      fauxAssistantMessage("完成，已读取两份内容"),
    ]);

    const events: CoreMindEvent[] = [];
    const agent = buildAgent(
      {
        systemPrompt: "测试助手",
        tools: [{ id: "read" }],
      },
      {
        models,
        model,
        tools: [createReadTool(dir)],
        agentName: "tester",
        onEvent: (e) => events.push(e),
      },
    );

    await agent.prompt("请读取 package.json");
    await agent.waitForIdle();

    // 事件序列：agent_start → tool_call → tool_result → text_delta → agent_end
    const types = events.map((e) => e.type);
    expect(types).toContain("agent_start");
    expect(types).toContain("agent_end");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("text_delta");

    // 事件都带 agent 名
    for (const e of events) {
      if (e.type === "agent_start" || e.type === "agent_end") expect(e.agent).toBe("tester");
    }

    // 工具事件细节
    const toolCalls = events.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls.map((event) => event.args)).toEqual([
      { path: "notes.txt" },
      { path: "notes-2.txt" },
    ]);
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(2);
    expect(toolResults.every((event) => !event.isError)).toBe(true);

    // 最终文本（从消息提取）
    const text = agent.state.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    expect(text).toContain("完成");
  });

  it("所有 AgentTool.execute 都经过 Harness 的唯一执行入口", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-tool-entry-"));
    writeFileSync(path.join(dir, "notes.txt"), "唯一入口", "utf8");
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })]),
      fauxAssistantMessage("完成"),
    ]);
    const original = createReadTool(dir);
    const adapter = vi.fn(original.execute.bind(original));
    const executeTool = vi.fn(async ({ invoke }) => invoke());
    const agent = buildAgent(
      { systemPrompt: "测试助手", tools: [{ id: "read" }] },
      {
        models,
        model,
        tools: [{ ...original, execute: adapter }],
        agentName: "tester",
        onEvent: () => undefined,
        harness: { executeTool },
      },
    );

    await agent.prompt("读取 notes.txt");
    await agent.waitForIdle();

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("Harness 执行入口拒绝时不会旁路调用原 Adapter", async () => {
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })]),
      fauxAssistantMessage("完成"),
    ]);
    const original = createReadTool(process.cwd());
    const adapter = vi.fn(original.execute.bind(original));
    const executeTool = vi.fn(async () => {
      throw new Error("Harness gate rejected");
    });
    const agent = buildAgent(
      { systemPrompt: "测试助手", tools: [{ id: "read" }] },
      {
        models,
        model,
        tools: [{ ...original, execute: adapter }],
        agentName: "tester",
        onEvent: () => undefined,
        harness: { executeTool },
      },
    );

    await agent.prompt("读取 notes.txt");
    await agent.waitForIdle();

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(adapter).not.toHaveBeenCalled();
  });

  it("配置加载的真实 Script Tool 仍在原 Adapter 前经过 ToolExecutionEngine", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-script-entry-"));
    temporaryRoots.push(dir);
    const marker = path.join(dir, "adapter-entered.marker");
    writeFileSync(
      path.join(dir, "script-tool.mjs"),
      `export default {
        name: "script_gate",
        description: "真实脚本工具入口",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(${JSON.stringify(marker)}, "entered", "utf8");
          return { content: [{ type: "text", text: "entered" }] };
        }
      };`,
      "utf8",
    );
    const built = await buildTools(
      [
        {
          path: "script-tool.mjs",
          effect: { operations: ["external"], reversible: false },
        },
      ],
      { cwd: dir, configDir: dir },
    );
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("script_gate", {})]),
      fauxAssistantMessage("完成"),
    ]);
    const lifecycleFacts: CoreMindEvent[] = [];
    const engine = new ToolExecutionEngine({
      persist: async (fact) => {
        lifecycleFacts.push(fact);
      },
    });
    const executeTool = vi.fn(async ({ call, invoke }) => {
      const identity = { agent: "tester", callId: call.callId };
      await engine.recordCall({ ...identity, tool: call.tool });
      for (const phase of [
        "capability_resolved",
        "policy_resolved",
        "approval_resolved",
        "lease_acquired",
        "checkpoint_durable",
      ] as const) {
        await engine.advance(identity, { phase, status: "completed" });
      }
      await engine.advance(identity, {
        phase: "started_durable",
        status: "completed",
        result: { effectState: "started" },
      });
      await engine.advance(identity, { phase: "executing", status: "completed" });
      const result = await engine.executeAdapter(identity, invoke);
      await engine.advance(identity, {
        phase: "observed",
        status: "completed",
        result: {
          executionOutcome: "returned",
          effectState: "committed",
          cleanupState: "not_needed",
        },
      });
      await engine.finalizeResult(identity);
      return result;
    });
    const agent = buildAgent(
      { systemPrompt: "测试助手" },
      {
        models,
        model,
        tools: built.tools,
        agentName: "tester",
        onEvent: () => undefined,
        harness: { executeTool },
      },
    );

    await agent.prompt("调用全部来源工具");
    await agent.waitForIdle();

    expect(built.warnings).toEqual([]);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(existsSync(marker)).toBe(true);
    expect(
      lifecycleFacts
        .filter((fact) => fact.type === "tool_lifecycle")
        .map((fact) => (fact.type === "tool_lifecycle" ? fact.resolution.phase : undefined)),
    ).toEqual([
      "call_recorded",
      "capability_resolved",
      "policy_resolved",
      "approval_resolved",
      "lease_acquired",
      "checkpoint_durable",
      "started_durable",
      "executing",
      "observed",
      "result_durable",
      "terminal",
    ]);
  });

  it("并行 Adapter 完成顺序不改写模型要求的 Tool Result 顺序与 callId", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-runtime-tool-order-"));
    writeFileSync(path.join(dir, "notes.txt"), "并行顺序", "utf8");
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("slow-read", { path: "notes.txt" }, { id: "call-slow" }),
        fauxToolCall("fast-read", { path: "notes.txt" }, { id: "call-fast" }),
      ]),
      fauxAssistantMessage("完成"),
    ]);
    const base = createReadTool(dir);
    let releaseSlow!: () => void;
    const fastCompleted = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const completionOrder: string[] = [];
    const slow = {
      ...base,
      name: "slow-read",
      label: "slow-read",
      execute: async (...args: Parameters<typeof base.execute>) => {
        await fastCompleted;
        completionOrder.push("slow");
        return base.execute(...args);
      },
    };
    const fast = {
      ...base,
      name: "fast-read",
      label: "fast-read",
      execute: async (...args: Parameters<typeof base.execute>) => {
        completionOrder.push("fast");
        releaseSlow();
        return base.execute(...args);
      },
    };
    const executeTool = vi.fn(async ({ invoke }) => invoke());
    const agent = buildAgent(
      { systemPrompt: "测试助手" },
      {
        models,
        model,
        tools: [slow, fast],
        agentName: "tester",
        onEvent: () => undefined,
        harness: { executeTool },
      },
    );

    await agent.prompt("并行读取");
    await agent.waitForIdle();

    expect(completionOrder).toEqual(["fast", "slow"]);
    expect(
      agent.state.messages
        .filter((message) => message.role === "toolResult")
        .map((message) => message.toolCallId),
    ).toEqual(["call-slow", "call-fast"]);
    expect(executeTool.mock.calls.map(([request]) => request.call.callId).sort()).toEqual([
      "call-fast",
      "call-slow",
    ]);
  });
});

describe("buildAgent（options 与 apiKey 注入）", () => {
  /** 包装 streamSimple 捕获每次请求的 options */
  function captureStreamOptions() {
    const { models, model, faux } = makeFauxContext();
    faux.setResponses([fauxAssistantMessage("ok")]);
    const calls: Array<Record<string, unknown>> = [];
    const real = models.streamSimple.bind(models);
    models.streamSimple = ((m, c, o) => {
      calls.push(o ?? {});
      return real(m, c, o);
    }) as typeof models.streamSimple;
    return { models, model, calls };
  }

  it("options 的 temperature/maxTokens 注入每次流式请求", async () => {
    const { models, model, calls } = captureStreamOptions();
    const agent = buildAgent(
      { systemPrompt: "t", options: { temperature: 0.3, maxTokens: 64 } },
      { models, model, tools: [], agentName: "t", onEvent: () => {} },
    );
    await agent.prompt("hi");
    await agent.waitForIdle();
    expect(calls.length).toBeGreaterThan(0);
    for (const o of calls) {
      expect(o.temperature).toBe(0.3);
      expect(o.maxTokens).toBe(64);
    }
  });

  it("apiKeyOverride 注入请求 apiKey", async () => {
    const { models, model, calls } = captureStreamOptions();
    const agent = buildAgent(
      { systemPrompt: "t" },
      {
        models,
        model,
        tools: [],
        agentName: "t",
        onEvent: () => {},
        apiKeyOverride: "sk-custom",
      },
    );
    await agent.prompt("hi");
    await agent.waitForIdle();
    expect(calls.length).toBeGreaterThan(0);
    for (const o of calls) expect(o.apiKey).toBe("sk-custom");
  });

  it("未配置 options 时不注入 temperature/maxTokens", async () => {
    const { models, model, calls } = captureStreamOptions();
    const agent = buildAgent(
      { systemPrompt: "t" },
      { models, model, tools: [], agentName: "t", onEvent: () => {} },
    );
    await agent.prompt("hi");
    await agent.waitForIdle();
    for (const o of calls) {
      expect(o.temperature).toBeUndefined();
      expect(o.maxTokens).toBeUndefined();
    }
  });

  it("skills 内容注入系统提示词", async () => {
    const { models, model } = makeFauxContext();
    const agent = buildAgent(
      { systemPrompt: "基础提示" },
      {
        models,
        model,
        tools: [],
        agentName: "t",
        onEvent: () => {},
        skillsContent: ["技能内容A", "技能内容B"],
      },
    );
    expect(agent.state.systemPrompt).toContain("基础提示");
    expect(agent.state.systemPrompt).toContain("# 专业技能");
    expect(agent.state.systemPrompt).toContain("技能内容A");
    expect(agent.state.systemPrompt).toContain("技能内容B");
  });

  it("无 skills 时仍生成稳定前缀并明确标记为空", async () => {
    const { models, model } = makeFauxContext();
    const agent = buildAgent(
      { systemPrompt: "基础提示" },
      { models, model, tools: [], agentName: "t", onEvent: () => {} },
    );
    expect(agent.state.systemPrompt).toContain("# CoreMind 稳定上下文 v1");
    expect(agent.state.systemPrompt).toContain("## 项目指令\n基础提示");
    expect(agent.state.systemPrompt).toContain("## 专业技能\n- 无");
  });

  it("把实际稳定前缀与工具 Schema 注册到 Runtime Context 合同", () => {
    const { models, model } = makeFauxContext();
    const contracts: Array<{ stablePrefix: string; toolSchemas: unknown[] }> = [];
    buildAgent(
      { systemPrompt: "预算合同" },
      {
        models,
        model,
        tools: [createReadTool(process.cwd())],
        agentName: "t",
        onEvent: () => {},
        harness: { registerContextContract: (contract) => contracts.push(contract) },
      },
    );

    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.stablePrefix).toContain("预算合同");
    expect(contracts[0]?.toolSchemas).toEqual([
      expect.objectContaining({ name: "read", description: expect.any(String) }),
    ]);
  });

  it("Context transform 失败后在网络流创建前失败关闭", async () => {
    const { models, model } = makeFauxContext();
    let blocked = false;
    let providerCalls = 0;
    const real = models.streamSimple.bind(models);
    models.streamSimple = ((m, c, o) => {
      providerCalls += 1;
      return real(m, c, o);
    }) as typeof models.streamSimple;
    const agent = buildAgent(
      { systemPrompt: "t" },
      {
        models,
        model,
        tools: [],
        agentName: "t",
        onEvent: () => {},
        harness: {
          transformContext: async (messages) => {
            blocked = true;
            return messages;
          },
          beforeModelRequest: () => {
            if (blocked) throw new Error("context_budget_exhausted");
          },
        },
      },
    );

    await agent.prompt("不能发送");
    await agent.waitForIdle();
    expect(providerCalls).toBe(0);
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      errorMessage: expect.stringContaining("context_budget_exhausted"),
    });
  });
});
