import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, parseAndValidate, validateConfig } from "./validate.js";

const server = {
  transport: "stdio",
  command: process.execPath,
  args: [path.resolve("mcp-fixture/server.mjs"), "--fixed"],
  cwd: path.resolve("mcp-fixture"),
};
const mcpTool = {
  mcp: { server: "inventory", tool: "lookup_item" },
  effect: { operations: ["external"], reversible: false },
  capability: {
    effect: "external",
    replay: "unknown",
    concurrency: "run_serial",
    checkpoint: "unsupported",
    durability: "critical",
  },
};

function mcpConfig(tools: unknown[] = [mcpTool], scope: "global" | "agent" = "agent") {
  return {
    schemaVersion: 2,
    name: "mcp-config",
    mcp: { servers: { inventory: server } },
    tools: scope === "global" ? tools : [],
    agents: { main: { systemPrompt: "配置测试", tools: scope === "agent" ? tools : [] } },
  };
}

describe("本地 MCP 配置", () => {
  it("无 MCP 的旧输入保持原解析结果和默认值", () => {
    const input = {
      schemaVersion: 2,
      name: "legacy-tools",
      agents: { main: { systemPrompt: "旧配置", tools: [{ id: "read" }] } },
    };
    expect(parseAndValidate(input)).toEqual({ config: { ...input, tools: [] }, warnings: [] });
  });

  it.each(["global", "agent"] as const)(
    "%s 可同时选择旧工具与 MCP，协议默认固定 legacy",
    (scope) => {
      const tools = [
        { id: "read" },
        { path: "./custom.mjs", effect: { operations: ["read"], reversible: true } },
        mcpTool,
      ];
      const input = mcpConfig(tools, scope);
      expect(parseAndValidate(input)).toEqual({
        config: {
          ...input,
          tools:
            scope === "global" ? [{ id: "read", enabled: true }, ...tools.slice(1)] : input.tools,
          mcp: { servers: { inventory: { ...server, protocolVersion: "legacy" } } },
        },
        warnings: [],
      });
    },
  );

  it.each(["legacy", "2026-07-28"])("保留显式固定协议 %s", (protocolVersion) => {
    expect(
      validateConfig({
        ...mcpConfig(),
        mcp: { servers: { inventory: { ...server, protocolVersion } } },
      }),
    ).toMatchObject({ mcp: { servers: { inventory: { protocolVersion } } } });
  });

  it.each([
    ["相对命令", { command: "node" }],
    ["相对工作目录", { cwd: "./service" }],
    ["命令含空字节", { command: `${process.execPath}\0` }],
    ["参数含空字节", { args: ["bad\0arg"] }],
    ["非数组参数", { args: "server.mjs" }],
    ["非 stdio", { transport: "http" }],
    ["自动探测协议", { protocolVersion: "auto" }],
    ["未知协议", { protocolVersion: "2025-03-26" }],
    ["隐式 shell", { shell: true }],
  ])("拒绝服务配置：%s", (_name, patch) => {
    expect(() =>
      validateConfig({
        ...mcpConfig(),
        mcp: { servers: { inventory: { ...server, ...patch } } },
      }),
    ).toThrow(ConfigValidationError);
  });

  it.each(["command", "args", "cwd"] as const)("服务必须显式提供 %s", (field) => {
    const incomplete: Record<string, unknown> = { ...server };
    delete incomplete[field];
    expect(() =>
      validateConfig({ ...mcpConfig(), mcp: { servers: { inventory: incomplete } } }),
    ).toThrow(ConfigValidationError);
  });

  it("凭据只保留 env/secretRef 引用，不解析或复制宿主值", () => {
    const env = {
      SERVICE_TOKEN: { env: "INVENTORY_SERVICE_TOKEN" },
      SECOND_TOKEN: { secretRef: "opaque/service-token" },
    };
    expect(
      validateConfig({ ...mcpConfig(), mcp: { servers: { inventory: { ...server, env } } } }),
    ).toMatchObject({ mcp: { servers: { inventory: { env } } } });
  });

  it.each([
    "plain-secret",
    { env: "" },
    { secretRef: "" },
    { env: "TOKEN", secretRef: "opaque/token" },
    { env: "TOKEN", fallback: "plain-secret" },
  ])("拒绝不透明引用以外的 env 值 %#", (value) => {
    expect(() =>
      validateConfig({
        ...mcpConfig(),
        mcp: { servers: { inventory: { ...server, env: { TOKEN: value } } } },
      }),
    ).toThrow(ConfigValidationError);
  });

  it.skipIf(process.platform !== "win32")("Windows 环境键大小写重复时拒绝歧义", () => {
    expect(() =>
      validateConfig({
        ...mcpConfig(),
        mcp: {
          servers: { inventory: { ...server, env: { TOKEN: { env: "A" }, token: { env: "B" } } } },
        },
      }),
    ).toThrow("mcp.servers.inventory.env");
  });

  it.each(["global", "agent"] as const)("%s 的 MCP 不能被旧 id/path 分支吞掉", (scope) => {
    for (const mixed of [{ id: "read" }, { path: "./custom.mjs" }]) {
      expect(() => validateConfig(mcpConfig([{ ...mcpTool, ...mixed }], scope))).toThrow(
        ConfigValidationError,
      );
    }
  });

  it.each(["global", "agent"] as const)("%s 的服务引用必须已声明且给出字段路径", (scope) => {
    const prefix = scope === "global" ? "tools.0" : "agents.main.tools.0";
    expect(() =>
      validateConfig(
        mcpConfig([{ ...mcpTool, mcp: { server: "missing", tool: "lookup_item" } }], scope),
      ),
    ).toThrow(`${prefix}.mcp.server`);
  });

  it.each([
    { server: "inventory", tool: "" },
    { server: "inventory", tool: "lookup_item", alias: "read" },
  ])("精确 MCP 引用不接受空工具名或额外别名 %#", (mcp) => {
    expect(() => validateConfig(mcpConfig([{ ...mcpTool, mcp }]))).toThrow(ConfigValidationError);
  });

  it.each(["global", "agent"] as const)("%s 内重复选择或冲突声明同一工具时拒绝", (scope) => {
    for (const duplicate of [
      mcpTool,
      { ...mcpTool, capability: { ...mcpTool.capability, replay: "safe" } },
    ]) {
      expect(() => validateConfig(mcpConfig([mcpTool, duplicate], scope))).toThrow("重复");
    }
  });

  it("不同 Agent 可独立选择同一服务工具", () => {
    const input = mcpConfig();
    expect(
      validateConfig({ ...input, agents: { ...input.agents, second: { tools: [mcpTool] } } }),
    ).toMatchObject({ agents: { main: { tools: [mcpTool] }, second: { tools: [mcpTool] } } });
  });

  it.each(["effect", "replay", "concurrency", "checkpoint", "durability"] as const)(
    "capability.%s 必填且不能使用未知枚举",
    (field) => {
      const incomplete: Record<string, unknown> = { ...mcpTool.capability };
      delete incomplete[field];
      for (const capability of [incomplete, { ...mcpTool.capability, [field]: "invalid" }]) {
        expect(() => validateConfig(mcpConfig([{ ...mcpTool, capability }]))).toThrow(
          ConfigValidationError,
        );
      }
    },
  );

  it.each([
    { effect: undefined },
    { effect: { operations: ["external"] } },
    { effect: { operations: ["invalid"], reversible: false } },
    { capability: { ...mcpTool.capability, effect: "none" } },
    { effect: { operations: ["process", "network"], reversible: false } },
    { capability: { ...mcpTool.capability, effect: "workspace", checkpoint: "none" } },
  ])("缺失或矛盾的 effect/capability 不会被投影成较低权限 %#", (patch) => {
    expect(() => validateConfig(mcpConfig([{ ...mcpTool, ...patch }]))).toThrow(
      ConfigValidationError,
    );
  });

  it.each([
    ["none", ["read"], "none"],
    ["workspace", ["read", "write"], "required"],
    ["process", ["process"], "unsupported"],
    ["network", ["network"], "none"],
    ["external", ["read", "external"], "unsupported"],
    ["unknown", ["external"], "unsupported"],
  ])("保留完整 %s 声明，未知能力仍由执行门失败关闭", (effect, operations, checkpoint) => {
    const declared = {
      ...mcpTool,
      effect: { operations, reversible: false },
      capability: { ...mcpTool.capability, effect, checkpoint },
    };
    expect(validateConfig(mcpConfig([declared]))).toMatchObject({
      agents: { main: { tools: [declared] } },
    });
  });
});
