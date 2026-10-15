import type { CoreMindConfig } from "coremind-config";
import { ArtifactStore } from "coremind-tools";
import { createFakeExecutionEnvironment } from "coremind-tools/internal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpRun, type McpHostOperation } from "./mcp-runtime.js";

const httpFactory = vi.hoisted(() => vi.fn());
vi.mock("coremind-tools/internal", async (original) => ({
  ...(await original<typeof import("coremind-tools/internal")>()),
  createMcpHttpClient: httpFactory,
}));

beforeEach(() => httpFactory.mockReset());

describe("HTTP MCP 的执行身份与惰性资源", () => {
  it("审批期间修改外部 URL 不改绑已固定的 HTTP 目标", async () => {
    const fixture = setup();
    const server = fixture.config.mcp!.servers.service!;
    if (server.transport !== "streamable-http") throw new Error("夹具类型错误");
    const originalUrl = server.url;
    const resolve = vi.fn(() => "private-header-value");
    const run = createMcpRun({ ...fixture.options, secretResolver: { resolve } });
    try {
      const tools = await run.prepare({
        agentName: "writer",
        executionId: "url-snapshot",
        executeHost: async (operation) => {
          if (operation.args.operation === "connect") {
            expect(operation.args.url).toBe(originalUrl);
            server.url = "https://other.example.test/changed";
          }
          return operation.invoke();
        },
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]!.authorization.url).toBe(originalUrl);
      expect(httpFactory).toHaveBeenCalledTimes(1);
      expect(httpFactory.mock.calls[0]![0].url).toBe(originalUrl);
      expect(resolve).toHaveBeenCalledWith("service-key");
    } finally {
      await run.close();
    }
  });

  it("审批参数的 Header 引用深冻结，外部引用变更不改用另一凭据", async () => {
    const fixture = setup();
    const server = fixture.config.mcp!.servers.service!;
    if (server.transport !== "streamable-http") throw new Error("夹具类型错误");
    server.headers = { Authorization: { env: "MCP_ORIGINAL" } };
    const run = createMcpRun({
      ...fixture.options,
      env: { MCP_ORIGINAL: "Bearer ORIGINAL-TOKEN", MCP_CHANGED: "Bearer CHANGED-TOKEN" },
    });
    try {
      const tools = await run.prepare({
        agentName: "writer",
        executionId: "header-snapshot",
        executeHost: async (operation) => {
          if (operation.args.operation === "connect") {
            const references = operation.args.headerReferences as {
              Authorization: { env: string };
            };
            expect(Object.isFrozen(references)).toBe(true);
            expect(Object.isFrozen(references.Authorization)).toBe(true);
            expect(() => {
              references.Authorization.env = "MCP_CHANGED";
            }).toThrow(TypeError);
            server.headers = { Authorization: { env: "MCP_CHANGED" } };
          }
          return operation.invoke();
        },
      });
      expect(tools).toHaveLength(1);
      expect(tools[0]!.authorization.headerReferences).toEqual({
        Authorization: { env: "MCP_ORIGINAL" },
      });
      expect(httpFactory).toHaveBeenCalledTimes(1);
      expect(httpFactory.mock.calls[0]![0].headers).toEqual({
        Authorization: "Bearer ORIGINAL-TOKEN",
      });
      expect(httpFactory.mock.calls[0]![0].sensitiveValues).not.toContain("CHANGED-TOKEN");
    } finally {
      await run.close();
    }
  });

  it.each(["env", "secretRef"] as const)(
    "%s 的 Header 规范化后仍登记实际发送的 Token 为秘密",
    async (kind) => {
      const fixture = setup();
      const server = fixture.config.mcp!.servers.service!;
      if (server.transport !== "streamable-http") throw new Error("夹具类型错误");
      server.headers = {
        Authorization: kind === "env" ? { env: "MCP_TEST_SECRET" } : { secretRef: "service-key" },
      };
      const run = createMcpRun({
        ...fixture.options,
        env: { MCP_TEST_SECRET: "  Bearer CANARY-SECRET  " },
        secretResolver: { resolve: () => "  Bearer CANARY-SECRET  " },
      });
      await run.prepare({ agentName: "writer", executionId: "normalized", executeHost: invoke });
      const options = httpFactory.mock.calls[0]![0];
      expect(options.headers.Authorization).toBe("Bearer CANARY-SECRET");
      expect(options.sensitiveValues).toContain("CANARY-SECRET");
      await run.close();
    },
  );
  it("仅资源授权在准备时不连接、解析凭据或读取任何目录", async () => {
    const fixture = setup();
    const executeHost = vi.fn(invoke);
    const resolve = vi.fn(() => "private-header-value");
    const run = createMcpRun({ ...fixture.options, secretResolver: { resolve } });
    const tools = await run.prepare({ agentName: "reader", executionId: "one", executeHost });
    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.authorization.operation)).toEqual([
      "resources/list",
      "resources/templates/list",
      "resources/read",
    ]);
    expect(executeHost).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(httpFactory).not.toHaveBeenCalled();
    expect(tools.every((tool) => tool.definition.capability?.concurrency === "parallel")).toBe(
      true,
    );
    await run.close();
  });

  it("无权 URI 与多余参数在惰性连接之前拒绝，不能只依赖模型 schema", async () => {
    const fixture = setup();
    const run = createMcpRun(fixture.options);
    const executeHost = vi.fn(invoke);
    const tools = await run.prepare({ agentName: "reader", executionId: "one", executeHost });
    const read = tools.find((tool) => tool.authorization.operation === "resources/read")!;
    await expect(
      read.definition.execute({ uri: "secret://other" }, { callId: "guess" }),
    ).rejects.toThrow();
    await expect(
      read.definition.execute({ uri: "note://allowed", target: "other" }, { callId: "extra" }),
    ).rejects.toThrow();
    expect(httpFactory).not.toHaveBeenCalled();
    expect(executeHost).not.toHaveBeenCalled();
    await run.close();
  });

  it("首次实际资源调用才独立准入连接，三种资源操作共用本执行连接", async () => {
    const fixture = setup();
    const resolve = vi.fn(() => "private-header-value");
    const operations: McpHostOperation[] = [];
    const run = createMcpRun({ ...fixture.options, secretResolver: { resolve } });
    const tools = await run.prepare({
      agentName: "reader",
      executionId: "one",
      executeHost: async (operation) => {
        operations.push(operation);
        expect(httpFactory).not.toHaveBeenCalled();
        return operation.invoke();
      },
    });
    for (const tool of tools) {
      await tool.definition.execute(
        tool.authorization.operation === "resources/read" ? { uri: "note://allowed" } : {},
        { callId: tool.definition.name },
      );
    }
    expect(operations).toHaveLength(1);
    expect(operations[0]!.capability.effect).toBe("network");
    expect(operations[0]!.args).toMatchObject({
      url: "https://mcp.example.test/service",
      operation: "connect",
    });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(httpFactory).toHaveBeenCalledTimes(1);
    expect(httpFactory.mock.calls[0]![0]).toMatchObject({
      headers: { Authorization: "private-header-value" },
      allowedResourceUris: ["note://allowed"],
    });
    expect(fixture.client.listTools).not.toHaveBeenCalled();
    expect(fixture.client.listResources).toHaveBeenCalledTimes(1);
    expect(fixture.client.listResourceTemplates).toHaveBeenCalledTimes(1);
    expect(fixture.client.readResource).toHaveBeenCalledWith(
      "note://allowed",
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(tools.map(({ authorization }) => authorization))).not.toContain(
      "private-header-value",
    );
    await run.close();
    expect(fixture.client.close).toHaveBeenCalledTimes(1);
  });

  it("只选择工具不隐式获得资源，HTTP 控制操作使用真实网络能力", async () => {
    const fixture = setup();
    const operations: McpHostOperation[] = [];
    const run = createMcpRun({
      ...fixture.options,
      secretResolver: { resolve: () => "private-header-value" },
    });
    const tools = await run.prepare({
      agentName: "writer",
      executionId: "tools",
      executeHost: async (operation) => {
        operations.push(operation);
        return operation.invoke();
      },
    });
    expect(tools).toHaveLength(1);
    expect(operations.map((operation) => operation.capability.effect)).toEqual([
      "network",
      "network",
    ]);
    expect(operations[0]!.args).not.toHaveProperty("command");
    expect(httpFactory.mock.calls[0]![0]).toMatchObject({ allowedResourceUris: [] });
    expect(fixture.client.listResources).not.toHaveBeenCalled();
    expect(fixture.client.readResource).not.toHaveBeenCalled();
    await tools[0]!.definition.execute({ value: false }, { callId: "business" });
    expect(fixture.client.callTool).toHaveBeenCalledWith(
      fixture.listed,
      { value: false },
      expect.any(AbortSignal),
    );
    await run.close();
  });

  it("Agent 不继承其他 Agent 资源，缺失凭据在真正创建客户端前失败", async () => {
    const fixture = setup();
    const run = createMcpRun(fixture.options);
    expect(
      await run.prepare({ agentName: "plain", executionId: "plain", executeHost: invoke }),
    ).toEqual([]);
    const tools = await run.prepare({
      agentName: "reader",
      executionId: "reader",
      executeHost: invoke,
    });
    await expect(tools[0]!.definition.execute({}, { callId: "missing" })).rejects.toMatchObject({
      code: "secret_reference_unresolved",
    });
    expect(httpFactory).not.toHaveBeenCalled();
    await run.close();
  });

  it("同连接并发资源只初始化一次，一个等待者取消不终止另一个", async () => {
    const fixture = setup();
    let release!: () => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    fixture.client.connect.mockImplementation(async () => {
      enter();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const run = createMcpRun({
      ...fixture.options,
      secretResolver: { resolve: () => "private-header-value" },
    });
    const tools = await run.prepare({
      agentName: "reader",
      executionId: "shared",
      executeHost: invoke,
    });
    const controller = new AbortController();
    const cancelled = tools[0]!.definition.execute(
      {},
      { callId: "cancelled", signal: controller.signal },
    );
    const rejected = expect(cancelled).rejects.toThrow();
    await entered;
    const kept = tools[1]!.definition.execute({}, { callId: "kept" });
    controller.abort();
    await rejected;
    release();
    await kept;
    expect(fixture.client.connect).toHaveBeenCalledTimes(1);
    expect(fixture.client.listResources).not.toHaveBeenCalled();
    expect(fixture.client.listResourceTemplates).toHaveBeenCalledTimes(1);
    expect(fixture.client.close).not.toHaveBeenCalled();
    await run.close();
  });
});

async function invoke(operation: McpHostOperation) {
  return operation.invoke();
}

function setup() {
  const listed = {
    name: "echo",
    description: "回声",
    inputSchema: { type: "object", properties: { value: {} } },
    schemaSha256: "a".repeat(64),
    definition: { name: "echo", inputSchema: { type: "object" } },
  };
  const result = { text: "资源结果", details: { mcp: { contents: [] } } };
  const client = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => [listed]),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => {}),
    listResources: vi.fn(async () => result),
    listResourceTemplates: vi.fn(async () => result),
    readResource: vi.fn(async () => result),
    environmentSummary: undefined,
  };
  httpFactory.mockImplementation(() => client);
  const config = {
    schemaVersion: 2,
    name: "http-mcp",
    mcp: {
      servers: {
        service: {
          transport: "streamable-http",
          url: "https://mcp.example.test/service",
          headers: { Authorization: { secretRef: "service-key" } },
        },
      },
    },
    agents: {
      reader: { systemPrompt: "读取", mcpResources: { service: ["note://allowed"] } },
      writer: {
        systemPrompt: "工具",
        tools: [
          {
            mcp: { server: "service", tool: "echo" },
            effect: { operations: ["external"], reversible: false },
            capability: {
              effect: "external",
              replay: "unknown",
              concurrency: "run_serial",
              checkpoint: "unsupported",
              durability: "critical",
            },
          },
        ],
      },
      plain: { systemPrompt: "普通" },
    },
    entry: { agent: "reader" },
  } as unknown as CoreMindConfig;
  return {
    client,
    listed,
    config,
    options: {
      config,
      configDir: process.cwd(),
      cwd: process.cwd(),
      env: {},
      artifactStore: new ArtifactStore({ cwd: process.cwd() }),
      environment: createFakeExecutionEnvironment({
        claimed: { networkEgress: "unrestricted" },
        observed: { networkEgress: "unrestricted" },
      }),
    },
  };
}
