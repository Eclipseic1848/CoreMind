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

const httpServer = {
  transport: "streamable-http",
  url: "https://inventory.example.test/mcp",
};

function httpConfig(patch: Record<string, unknown> = {}) {
  return {
    ...mcpConfig(),
    mcp: { servers: { inventory: { ...httpServer, ...patch } } },
  };
}

describe("HTTP MCP 配置与精确资源授权", () => {
  it("HTTP 与 stdio 可共存，Header 引用不解析且协议仍默认 legacy", () => {
    const headers = {
      Authorization: { env: "INVENTORY_TOKEN" },
      "X-Api-Key": { secretRef: "opaque/inventory/key" },
      "X-Client-Name": "CoreMind",
    };
    const input = {
      ...httpConfig({ headers }),
      mcp: { servers: { inventory: { ...httpServer, headers }, local: server } },
    };
    expect(parseAndValidate(input)).toMatchObject({
      config: {
        mcp: {
          servers: {
            inventory: { ...httpServer, headers, protocolVersion: "legacy" },
            local: { ...server, protocolVersion: "legacy" },
          },
        },
      },
      warnings: [],
    });
  });

  it.each([
    { url: "http://127.0.0.1:8765/mcp", allowedAddresses: ["127.0.0.1"] },
    { url: "http://[::1]:8765/mcp", allowedAddresses: ["::1"] },
    { url: "https://10.2.3.4/mcp", allowedAddresses: ["10.2.3.4"] },
    { protocolVersion: "2026-07-28", allowedAddresses: ["203.0.113.9", "2001:db8::9"] },
  ])("保留固定端点与显式精确地址 %#", (patch) => {
    expect(validateConfig(httpConfig(patch))).toMatchObject({
      mcp: { servers: { inventory: { ...httpServer, ...patch } } },
    });
  });

  it.each([
    { url: "not-a-url" },
    { url: "ftp://inventory.example.test/mcp" },
    { url: "https://user:secret@inventory.example.test/mcp" },
    { url: "https://@inventory.example.test/mcp" },
    { url: "https://inventory.example.test/mcp?tenant=one" },
    { url: "https://inventory.example.test/mcp#fragment" },
    { url: "https://inventory.example.test/mcp\n" },
    { url: "http://inventory.example.test/mcp", allowedAddresses: ["203.0.113.9"] },
    { url: "http://127.0.0.1:8765/mcp" },
    { url: "http://127.0.0.1:8765/mcp", allowedAddresses: ["127.0.0.2"] },
    { url: "http://localhost:8765/mcp", allowedAddresses: ["127.0.0.1"] },
    { url: "http://2130706433:8765/mcp", allowedAddresses: ["127.0.0.1"] },
    { allowedAddresses: ["127.0.0.1/8"] },
    { allowedAddresses: ["localhost"] },
    { allowedAddresses: ["999.1.2.3"] },
    { allowedAddresses: ["fe80::1%eth0"] },
    { allowedAddresses: ["127.0.0.1", "127.0.0.1"] },
    { allowedAddresses: [] },
    { command: process.execPath },
    { args: [] },
    { cwd: path.resolve("fixture") },
    { env: { TOKEN: { env: "TOKEN" } } },
  ])("非法目标、地址语法与混合传输字段在静态阶段拒绝 %#", (patch) => {
    expect(() => validateConfig(httpConfig(patch))).toThrow(ConfigValidationError);
  });

  it.each([
    { "X-Client": "one", "x-client": "two" },
    { "Bad Header": "value" },
    { "X-Client\n": "value" },
    { "X-Client": "bad\r\nvalue" },
    { "X-Client": { env: "TOKEN", secretRef: "opaque/token" } },
    ...[
      "Host",
      "Content-Length",
      "Transfer-Encoding",
      "Connection",
      "Keep-Alive",
      "TE",
      "Trailer",
      "Proxy-Connection",
      "Upgrade",
      "Proxy-Authorization",
      "MCP-Session-Id",
      "DPoP",
      "MCP-Protocol-Version",
      "MCP-Method",
      "MCP-Name",
      "Last-Event-ID",
      "Accept",
      "Content-Type",
    ].map((name) => ({ [name]: { env: "OVERRIDE" } })),
  ])("Header 歧义、注入与传输保留名不会被清理成合法配置 %#", (headers) => {
    expect(() => validateConfig(httpConfig({ headers }))).toThrow(ConfigValidationError);
  });

  it("每个 Agent 原样保留精确资源 URI，缺省与空集合不会继承", () => {
    const selected = ["inventory://items/甲", "https://data.example.test/item%2Fone?q=1"];
    const input = {
      ...httpConfig(),
      agents: {
        selected: { mcpResources: { inventory: selected } },
        empty: { mcpResources: {} },
        emptyServer: { mcpResources: { inventory: [] } },
        other: {},
      },
    };
    const parsed = validateConfig(input);
    expect(parsed.agents.selected?.mcpResources).toEqual({ inventory: selected });
    expect(parsed.agents.empty?.mcpResources).toEqual({});
    expect(parsed.agents.emptyServer?.mcpResources).toEqual({ inventory: [] });
    expect(parsed.agents.other).not.toHaveProperty("mcpResources");
  });

  it.each([
    { missing: ["inventory://item/1"] },
    { inventory: ["inventory://item/1", "inventory://item/1"] },
    { inventory: [""] },
    { inventory: ["relative/item"] },
    { inventory: ["inventory://item/one\n"] },
    { inventory: ["inventory://item/\0one"] },
    { inventory: ["inventory://item/\u007fone"] },
    { inventory: "inventory://item/1" },
  ])("非法资源范围不能被未知 Agent 字段规则吞掉 %#", (mcpResources) => {
    expect(() => validateConfig({ ...httpConfig(), agents: { main: { mcpResources } } })).toThrow(
      ConfigValidationError,
    );
  });

  it("stdio 资源选择明确 invalid_config，不暗中增加宿主资源语义", () => {
    expect(() =>
      validateConfig({
        ...mcpConfig(),
        agents: { main: { mcpResources: { inventory: ["inventory://item/1"] } } },
      }),
    ).toThrow(ConfigValidationError);
  });
});
