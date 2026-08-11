import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createReadTool } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildAgent } from "./agent-factory.js";
import type { CoreMindEvent } from "./events.js";

function makeFauxContext() {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, model: faux.getModel(), faux };
}

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
});
