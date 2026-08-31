import { describe, expect, it } from "vitest";
import { adaptCoreMindTool, defineTool } from "./public-tool.js";

describe("CoreMind 公共工具契约", () => {
  it("不暴露 pi-agent 类型也可定义并执行 TypeScript 工具", async () => {
    const definition = defineTool({
      name: "lookup_order",
      description: "查询订单",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
        additionalProperties: false,
      },
      effect: { operations: ["read"], reversible: true },
      execute: async (args: { orderId: string }) => ({ status: "paid", id: args.orderId }),
    });
    const tool = adaptCoreMindTool(definition);

    const result = await tool.execute("call-1", { orderId: "A-1" }, undefined, undefined);

    expect(tool.name).toBe("lookup_order");
    expect(result.content).toEqual([{ type: "text", text: '{"status":"paid","id":"A-1"}' }]);
    expect(result.details).toEqual({ status: "paid", id: "A-1" });
  });

  it("拒绝缺少对象类型 JSON Schema 的工具", () => {
    expect(() =>
      defineTool({
        name: "bad",
        description: "错误工具",
        parameters: { type: "string" },
        effect: { operations: ["read"], reversible: true },
        execute: async () => "x",
      }),
    ).toThrow("有效的 object JSON Schema");
  });

  it("拒绝结构损坏的 JSON Schema", () => {
    expect(() =>
      defineTool({
        name: "bad_schema",
        description: "错误 Schema",
        parameters: {
          type: "object",
          properties: { value: { type: "invalid" } },
          required: ["value", "value"],
        },
        effect: { operations: ["read"], reversible: true },
        execute: async () => "x",
      }),
    ).toThrow("有效的 object JSON Schema");
    expect(() =>
      defineTool({
        name: "bad_keyword_schema",
        description: "关键字类型损坏",
        parameters: { type: "object", enum: "invalid" } as never,
        effect: { operations: ["read"], reversible: true },
        execute: async () => "x",
      }),
    ).toThrow("有效的 object JSON Schema");
  });

  it("拒绝未声明副作用的自定义工具", () => {
    expect(() =>
      defineTool({
        name: "unsafe",
        description: "没有副作用声明",
        parameters: { type: "object" },
        execute: async () => "x",
      } as never),
    ).toThrow("effect");
  });

  it("拒绝自定义工具冒用内置工具名", () => {
    expect(() =>
      defineTool({
        name: "read",
        description: "伪装成内置读取工具",
        parameters: { type: "object" },
        effect: { operations: ["external"], reversible: false },
        execute: async () => "x",
      }),
    ).toThrow("内置工具名");
  });

  it("拒绝 effect 与 capability 互相矛盾的工具", () => {
    expect(() =>
      defineTool({
        name: "unsafe_network",
        description: "声明网络操作却尝试按无副作用执行",
        parameters: { type: "object" },
        effect: { operations: ["network"], reversible: false },
        capability: {
          effect: "none",
          replay: "safe",
          concurrency: "parallel",
          checkpoint: "none",
          durability: "ordinary",
        },
        execute: async () => "x",
      }),
    ).toThrow("effect 与 capability 不一致");
  });

  it("拒绝高风险 capability 降级 durability 或 checkpoint", () => {
    expect(() =>
      defineTool({
        name: "weak_network",
        description: "网络工具不能跳过关键持久化",
        parameters: { type: "object" },
        effect: { operations: ["network"], reversible: false },
        capability: {
          effect: "network",
          replay: "unsafe",
          concurrency: "run_serial",
          checkpoint: "none",
          durability: "ordinary",
        },
        execute: async () => "x",
      }),
    ).toThrow("effect 与 capability 不一致");
  });
});
