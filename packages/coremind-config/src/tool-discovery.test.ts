import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, validateConfig } from "./validate.js";

const tools = [
  { id: "read" },
  { path: "./lookup.mjs", effect: { operations: ["read"], reversible: true } },
  {
    mcp: { server: "inventory", tool: "lookup" },
    effect: { operations: ["read"], reversible: true },
    capability: {
      effect: "none",
      replay: "safe",
      concurrency: "parallel",
      checkpoint: "none",
      durability: "ordinary",
    },
  },
];

function config(schemaVersion: number, selected: unknown[], global = false) {
  return {
    schemaVersion,
    name: "discovery",
    tools: global ? selected : [],
    agents: { main: { systemPrompt: "按授权发现工具", tools: global ? [] : selected } },
    mcp: {
      servers: {
        inventory: {
          transport: "stdio",
          command: process.execPath,
          args: [path.resolve("inventory.mjs")],
          cwd: path.resolve("."),
        },
      },
    },
  };
}

describe("工具按需曝光的显式配置版本", () => {
  it.each(tools)("v3 保留合法 deferred 配置 %j", (tool) => {
    const parsed = validateConfig(config(3, [{ ...tool, exposure: "deferred" }]));
    expect(parsed.agents.main.tools).toEqual([{ ...tool, exposure: "deferred" }]);
  });

  it.each([false, true])("v2 拒绝 deferred（全局 %s）", (global) => {
    expect(() => validateConfig(config(2, [{ id: "read", exposure: "deferred" }], global))).toThrow(
      /schemaVersion.*3/,
    );
  });

  it.each(tools)("拒绝未知曝光值，不能被旧宽松分支吞掉 %j", (tool) => {
    expect(() => validateConfig(config(3, [{ ...tool, exposure: "hidden" }]))).toThrow(
      ConfigValidationError,
    );
  });

  it("旧 v2 省略曝光不注入新字段，也不改写输入", () => {
    const input = config(2, [{ id: "read" }]);
    const before = JSON.stringify(input);
    const parsed = validateConfig(input);
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.agents.main.tools).toEqual([{ id: "read" }]);
    expect(parsed.agents.main.tools?.[0]).not.toHaveProperty("exposure");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("旧 v2 可显式声明 direct 而无需升级文件", () => {
    expect(
      validateConfig(config(2, [{ id: "read", exposure: "direct" }])).agents.main.tools,
    ).toEqual([{ id: "read", exposure: "direct" }]);
  });
});
