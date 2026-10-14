import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { ArtifactStore, type ToolCapabilityDeclaration } from "coremind-tools";
import {
  createFakeExecutionEnvironment,
  type McpListedTool,
  type McpStdioClient,
  type McpStdioClientOptions,
} from "coremind-tools/internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { createMcpRun, type McpHostOperation } from "./mcp-runtime.js";

const clientFactory = vi.hoisted(() => vi.fn());
vi.mock("coremind-tools/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("coremind-tools/internal")>()),
  createMcpStdioClient: clientFactory,
}));

const effect = { operations: ["external"], reversible: false } as const;
const capability = {
  effect: "external",
  replay: "unknown",
  concurrency: "run_serial",
  checkpoint: "unsupported",
  durability: "critical",
} as const;
const directories: string[] = [];

beforeEach(() => clientFactory.mockReset());
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("MCP Run 私有目录准备", () => {
  it("未选择服务时不创建客户端、不解析秘密，空 Agent 工具保留全局回退", async () => {
    const fixture = await setup();
    const resolve = vi.fn(() => "不可读取的秘密");
    const run = createMcpRun({ ...fixture.options, secretResolver: { resolve } });
    expect(
      await run.prepare({ agentName: "plain", executionId: "empty", executeHost: invoke }),
    ).toEqual([]);
    expect(clientFactory).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    fixture.config.agents.main!.tools = [];
    const prepared = await run.prepare({
      agentName: "main",
      executionId: "inherited",
      executeHost: invoke,
    });
    expect(prepared).toHaveLength(1);
    expect(clientFactory).toHaveBeenCalledTimes(1);
    await run.close();
  });

  it("完整 Host 准入前不创建客户端，拒绝连接时启动与秘密解析均为零", async () => {
    const fixture = await setup();
    const resolve = vi.fn(() => "private-token");
    const run = createMcpRun({ ...fixture.options, secretResolver: { resolve } });
    const denied = vi.fn(async (operation: McpHostOperation) => {
      expect(operation.capability).toMatchObject({
        effect: "process",
        durability: "critical",
        replay: "unknown",
      });
      expect(operation.effect.operations).toEqual(["process"]);
      throw new Error("Host 准入拒绝");
    });
    await expect(
      run.prepare({ agentName: "main", executionId: "denied", executeHost: denied }),
    ).rejects.toThrow("Host 准入拒绝");
    expect(clientFactory).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    await run.close();
  });

  it("connect 与 list 独立准入，精确快照、授权身份与原始业务参数各归其位", async () => {
    const fixture = await setup();
    const operations: McpHostOperation[] = [];
    const run = createMcpRun(fixture.options);
    const prepared = await run.prepare({
      agentName: "main",
      executionId: "selected",
      executeHost: async (operation) => {
        operations.push(operation);
        return operation.invoke();
      },
    });
    expect(operations.map((operation) => operation.capability.effect)).toEqual([
      "process",
      "external",
    ]);
    expect(operations.map((operation) => operation.capability.durability)).toEqual([
      "critical",
      "critical",
    ]);
    expect(prepared).toHaveLength(1);
    const selected = prepared[0]!;
    expect(selected.definition.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u);
    expect(selected.authorization).toMatchObject({
      server: "inventory",
      command: await realpath(fixture.command),
      cwd: await realpath(fixture.directory),
      tool: "lookup_item",
      schemaSha256: fixture.listed.schemaSha256,
      effect,
      capability,
    });
    expect(selected.definition.parameters).toEqual(fixture.listed.inputSchema);
    expect(selected.definition.parameters.$defs).toEqual({ identifier: { type: "string" } });
    const raw = { id: "item-1", mcp: { server: "伪造目标" } };
    expect(await selected.definition.execute(raw, { callId: "business-1" })).toEqual({
      text: "真实结果",
      details: { mcp: { structuredContent: false } },
    });
    expect(fixture.clients[0]!.callTool).toHaveBeenCalledWith(
      fixture.listed,
      raw,
      expect.any(AbortSignal),
    );
    expect(clientFactory.mock.calls[0]![0]).toMatchObject({
      env: { PATH: "fixture-path", SERVICE_TOKEN: "service-private-value" },
      runEnvironment: fixture.options.environment,
    });
    const metadata = JSON.stringify({
      operations: operations.map(({ invoke: _invoke, ...metadata }) => metadata),
      authorization: selected.authorization,
      description: selected.approvalDescription,
    });
    expect(metadata).not.toContain("service-private-value");
    expect(metadata).not.toContain("host-provider-value");
    expect((clientFactory.mock.calls[0]![0] as McpStdioClientOptions).env).not.toHaveProperty(
      "OPENAI_API_KEY",
    );
    expect((clientFactory.mock.calls[0]![0] as McpStdioClientOptions).env).not.toHaveProperty(
      "NODE_OPTIONS",
    );
    await run.close();
  });

  it("每个 execution 独立拥有客户端，同 execution 重复准备只执行一次", async () => {
    const fixture = await setup();
    const run = createMcpRun(fixture.options);
    const request = { agentName: "main", executionId: "one", executeHost: invoke };
    const [first, duplicate] = await Promise.all([run.prepare(request), run.prepare(request)]);
    expect(duplicate).toBe(first);
    await run.prepare({ ...request, executionId: "two" });
    expect(clientFactory).toHaveBeenCalledTimes(2);
    await expect(run.prepare({ ...request, agentName: "plain" })).rejects.toMatchObject({
      code: "tool_capability_conflict",
    });
    await Promise.all([run.close(), run.close()]);
    for (const client of fixture.clients) expect(client.close).toHaveBeenCalledTimes(1);
    await expect(run.prepare({ ...request, executionId: "closed" })).rejects.toMatchObject({
      code: "tool_execution_failed",
    });
  });

  it("初始化失败仍拥有资源，close 清理全部客户端并暴露失败", async () => {
    const fixture = await setup();
    const failure = new Error("初始化失败");
    clientFactory.mockImplementationOnce(() => {
      const client = mockClient(fixture.listed);
      client.connect.mockRejectedValue(failure);
      fixture.clients.push(client);
      return client;
    });
    const run = createMcpRun(fixture.options);
    await expect(
      run.prepare({ agentName: "main", executionId: "failed", executeHost: invoke }),
    ).rejects.toBe(failure);
    await run.prepare({ agentName: "main", executionId: "other", executeHost: invoke });
    fixture.clients[0]!.close.mockRejectedValue(new Error("关闭失败"));
    await expect(run.close()).rejects.toMatchObject({ code: "environment_terminate_failed" });
    for (const client of fixture.clients) expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("关闭期间秘密解析晚返回不能创建迟到客户端", async () => {
    const fixture = await setup();
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const secret = new Promise<string>((resolve) => {
      release = resolve;
    });
    fixture.config.mcp!.servers.inventory!.env = { SERVICE_TOKEN: { secretRef: "late-key" } };
    const run = createMcpRun({
      ...fixture.options,
      secretResolver: {
        resolve: () => {
          entered();
          return secret;
        },
      },
    });
    const preparing = run.prepare({ agentName: "main", executionId: "late", executeHost: invoke });
    await started;
    await run.close();
    release("late-private-value");
    await expect(preparing).rejects.toMatchObject({ code: "tool_execution_failed" });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("真实脚本、schema、声明或目标变化都会改变别名，目录完整字段参与绑定", async () => {
    const fixture = await setup();
    const names: string[] = [];
    for (let index = 0; index < 7; index++) {
      if (index === 1) await writeFile(fixture.script, "export const changed = true;", "utf8");
      if (index === 2)
        fixture.listed = listedTool({ $defs: { identifier: { type: "string", minLength: 2 } } });
      if (index === 3) fixture.config.tools = [mcpTool({ ...capability, replay: "unsafe" })];
      if (index === 4) fixture.config.mcp!.servers.inventory!.args = [fixture.script, "new-target"];
      if (index === 5) await writeFile(fixture.command, "另一个可信测试程序", "utf8");
      if (index === 6)
        fixture.listed = {
          ...fixture.listed,
          definition: { ...fixture.listed.definition, description: "目录描述已改变" },
        };
      const run = createMcpRun(fixture.options);
      names.push(
        (await run.prepare({ agentName: "main", executionId: "identity", executeHost: invoke }))[0]!
          .definition.name,
      );
      await run.close();
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it.each([
    { kind: "转义", names: ["lookup.item", "lookup_item"] },
    { kind: "截断", names: ["abcdefghijkl_first", "abcdefghijkl_second"] },
  ])("原名$kind后同前缀仍生成不同合法别名且不会互串调用", async ({ names }) => {
    const fixture = await setup();
    const tools = names.map((name) => {
      const tool = listedTool();
      return { ...tool, name, definition: { ...tool.definition, name } };
    });
    fixture.config.tools = names.map((name) => ({
      ...mcpTool(),
      mcp: { server: "inventory", tool: name },
    }));
    const client = mockClient(tools[0]!);
    client.listTools.mockResolvedValue(tools);
    clientFactory.mockImplementationOnce(() => {
      fixture.clients.push(client);
      return client;
    });
    const run = createMcpRun(fixture.options);
    try {
      const prepared = await run.prepare({
        agentName: "main",
        executionId: "similar-names",
        executeHost: invoke,
      });
      expect(prepared).toHaveLength(2);
      expect(new Set(prepared.map((tool) => tool.definition.name)).size).toBe(2);
      for (const tool of prepared) {
        expect(tool.definition.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u);
      }
      expect(prepared.map((tool) => tool.authorization.tool)).toEqual(names);
      const args = [{ id: "first-item" }, { id: "second-item" }];
      for (const [index, tool] of prepared.entries()) {
        await tool.definition.execute(args[index]!, { callId: `business-${index}` });
        expect(client.callTool).toHaveBeenNthCalledWith(
          index + 1,
          tools[index],
          args[index],
          expect.any(AbortSignal),
        );
      }
      expect(clientFactory).toHaveBeenCalledTimes(1);
      expect(client.callTool).toHaveBeenCalledTimes(2);
    } finally {
      await run.close();
    }
  });

  it("未知原名与实际工具撞名失败关闭，不能静默省略选择", async () => {
    const fixture = await setup();
    const first = createMcpRun(fixture.options);
    const name = (
      await first.prepare({ agentName: "main", executionId: "first", executeHost: invoke })
    )[0]!.definition.name;
    await first.close();
    const collision = createMcpRun(fixture.options);
    await expect(
      collision.prepare({
        agentName: "main",
        executionId: "collision",
        executeHost: invoke,
        reservedToolNames: [name],
      }),
    ).rejects.toMatchObject({ code: "invalid_tool" });
    await collision.close();
    fixture.config.tools = [{ ...mcpTool(), mcp: { server: "inventory", tool: "missing" } }];
    const missing = createMcpRun(fixture.options);
    await expect(
      missing.prepare({ agentName: "main", executionId: "missing", executeHost: invoke }),
    ).rejects.toMatchObject({ code: "invalid_tool" });
    await missing.close();
  });

  it("批准等待期间真实脚本变化时不创建客户端", async () => {
    const fixture = await setup();
    const run = createMcpRun(fixture.options);
    await expect(
      run.prepare({
        agentName: "main",
        executionId: "changed",
        executeHost: async (operation) => {
          await writeFile(fixture.script, "export const unapproved = true;", "utf8");
          return operation.invoke();
        },
      }),
    ).rejects.toMatchObject({ code: "tool_capability_conflict" });
    expect(clientFactory).not.toHaveBeenCalled();
    await run.close();
  });

  it("拒绝目录准入不发送 list，已有连接仍在 Run 内关闭", async () => {
    const fixture = await setup();
    const run = createMcpRun(fixture.options);
    await expect(
      run.prepare({
        agentName: "main",
        executionId: "deny-list",
        executeHost: async (operation) => {
          if (operation.capability.effect === "external") throw new Error("目录未批准");
          return operation.invoke();
        },
      }),
    ).rejects.toThrow("目录未批准");
    expect(fixture.clients[0]!.connect).toHaveBeenCalledTimes(1);
    expect(fixture.clients[0]!.listTools).not.toHaveBeenCalled();
    expect(fixture.clients[0]!.callTool).not.toHaveBeenCalled();
    await run.close();
    expect(fixture.clients[0]!.close).toHaveBeenCalledTimes(1);
  });
});

async function invoke(operation: McpHostOperation) {
  return operation.invoke();
}

function mcpTool(
  declaration: ToolCapabilityDeclaration = capability,
): Extract<NonNullable<CoreMindConfig["tools"]>[number], { mcp: unknown }> {
  return {
    mcp: { server: "inventory", tool: "lookup_item" },
    effect: { ...effect, operations: [...effect.operations] },
    capability: declaration,
  };
}

function listedTool(extra: Record<string, unknown> = {}): McpListedTool {
  const inputSchema = {
    type: "object",
    properties: { id: { $ref: "#/$defs/identifier" } },
    $defs: { identifier: { type: "string" } },
    ...extra,
  };
  const definition = { name: "lookup_item", description: "查询记录", inputSchema };
  return {
    ...definition,
    schemaSha256: fingerprintEffectReceiptValue({ inputSchema }),
    definition,
  };
}

function mockClient(tool: McpListedTool) {
  return {
    environmentSummary: undefined,
    connect: vi.fn(async () => {}),
    listTools: vi.fn(async () => [tool]),
    callTool: vi.fn(async () => ({
      text: "真实结果",
      details: { mcp: { structuredContent: false } },
    })),
    close: vi.fn(async () => {}),
  } satisfies McpStdioClient;
}

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-runtime-"));
  directories.push(directory);
  const command = path.join(directory, process.platform === "win32" ? "host.exe" : "host");
  const script = path.join(directory, "server.mjs");
  await writeFile(command, "可信测试程序身份", "utf8");
  await writeFile(script, "export const server = true;", "utf8");
  const config: CoreMindConfig = {
    schemaVersion: 2,
    name: "本地 MCP",
    agents: { main: {}, plain: { tools: [{ id: "read" }] } },
    tools: [mcpTool()],
    mcp: {
      servers: {
        inventory: {
          transport: "stdio",
          command,
          args: [script],
          cwd: directory,
          env: { SERVICE_TOKEN: { env: "SERVICE_TOKEN" } },
        },
      },
    },
  };
  const fixture = {
    directory,
    command,
    script,
    config,
    listed: listedTool(),
    clients: [] as ReturnType<typeof mockClient>[],
    options: {
      config,
      configDir: directory,
      cwd: directory,
      env: {
        PATH: "fixture-path",
        SERVICE_TOKEN: "service-private-value",
        OPENAI_API_KEY: "host-provider-value",
        NODE_OPTIONS: "--require=untrusted",
      },
      environment: createFakeExecutionEnvironment({
        claimed: { networkEgress: "unrestricted" },
        observed: { networkEgress: "unrestricted" },
      }),
      artifactStore: new ArtifactStore({ cwd: directory }),
    },
  };
  clientFactory.mockImplementation(() => {
    const client = mockClient(fixture.listed);
    fixture.clients.push(client);
    return client;
  });
  return fixture;
}
