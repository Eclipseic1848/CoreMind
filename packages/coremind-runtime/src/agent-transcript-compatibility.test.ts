import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { buildAgentDriver } from "./agent-factory.js";
import type { CoreMindMessage } from "./public-message.js";

function modelFixture(responses = [fauxAssistantMessage("完成")]) {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const requests: Array<Parameters<typeof models.streamSimple>[1]> = [];
  const stream = models.streamSimple.bind(models);
  models.streamSimple = (model, context, options) => {
    requests.push(context);
    return stream(model, context, options);
  };
  return { models, model: faux.getModel(), requests };
}

describe("模型执行消息与会话正文兼容", () => {
  it("系统合同只进入实际请求，预算、回放事实与持久化正文不重复计数", async () => {
    const fixture = modelFixture();
    const transform = vi.fn(async (messages: CoreMindMessage[]) => messages);
    const dispatched: unknown[][] = [];
    const driver = buildAgentDriver(
      { systemPrompt: "独立合同" },
      {
        ...fixture,
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        harness: {
          transformContext: transform,
          onModelRequestDispatched: ({ messages }) => dispatched.push(messages),
        },
      },
    );
    expect(driver.messages()).toEqual([]);
    await driver.prompt("第一轮");
    await driver.waitForIdle();
    await driver.prompt("第二轮");
    await driver.waitForIdle();
    expect(transform.mock.calls.map(([messages]) => messages.length)).toEqual([1, 3]);
    expect(dispatched.map((messages) => messages.length)).toEqual([1, 3]);
    expect(
      fixture.requests.map(({ messages }) => messages.filter((m) => m.role === "system").length),
    ).toEqual([1, 1]);
    expect(fixture.requests[0]?.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("独立合同"),
    });
    expect(driver.messages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("恢复后的历史摘要仍发给模型且不覆盖存储中的原始摘要消息", async () => {
    const fixture = modelFixture();
    const summary = {
      role: "compactionSummary",
      summary: "必须保留的旧结论",
      tokensBefore: 999,
      timestamp: 10,
    };
    const driver = buildAgentDriver(
      { systemPrompt: "恢复" },
      {
        ...fixture,
        tools: [],
        agentName: "main",
        onEvent: () => undefined,
        sessionMessages: [summary],
      },
    );
    await driver.prompt("继续");
    await driver.waitForIdle();
    expect(fixture.requests[0]?.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: expect.stringContaining(summary.summary) }],
      }),
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "继续" }] }),
    ]);
    expect(driver.messages()[0]).toEqual(summary);
  });

  it("工具批次后拒绝继续时不再创建下一次模型请求", async () => {
    const fixture = modelFixture([
      fauxAssistantMessage([fauxToolCall("echo", {})]),
      fauxAssistantMessage("不应发送"),
    ]);
    const finish = vi.fn(() => true);
    const driver = buildAgentDriver(
      { systemPrompt: "停止门" },
      {
        ...fixture,
        tools: [
          {
            name: "echo",
            label: "echo",
            description: "回显",
            parameters: Type.Object({}),
            execute: async () => ({ content: [{ type: "text", text: "已执行" }], details: {} }),
          },
        ],
        agentName: "main",
        onEvent: () => undefined,
        harness: { shouldStopAfterTurn: finish },
      },
    );
    await driver.prompt("执行一次");
    await driver.waitForIdle();
    expect(fixture.requests).toHaveLength(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(driver.messages().at(-1)).toMatchObject({ role: "toolResult", isError: false });
  });

  it.each(["error", "aborted"] as const)(
    "%s 响应保持终止且不调用正常完成钩子",
    async (stopReason) => {
      const fixture = modelFixture([{ ...fauxAssistantMessage("终止"), stopReason }]);
      const finish = vi.fn(() => false);
      const driver = buildAgentDriver(
        { systemPrompt: "失败边界" },
        {
          ...fixture,
          tools: [],
          agentName: "main",
          onEvent: () => undefined,
          harness: { shouldStopAfterTurn: finish },
        },
      );
      await driver.prompt("执行");
      await driver.waitForIdle();
      expect(finish).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(1);
      expect(driver.messages().at(-1)).toMatchObject({ role: "assistant", stopReason });
    },
  );
});
