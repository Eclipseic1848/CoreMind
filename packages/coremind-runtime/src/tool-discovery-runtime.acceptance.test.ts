import "../../../test/setup-env.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { FileRunStore } from "./run-state.js";
import { CoreMindRuntime, type CoreMindRuntimeOptions } from "./runtime.js";

interface Request {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
}
type Reply = string | Array<{ name: string; args: unknown }>;

it("真实请求仅在成功发现已持久后安装 read，目录与声明都不成为公开事实", async () => {
  await scenario(async ({ requests, run, store }) => {
    const result = await run();
    expect(
      result.outcome,
      JSON.stringify({
        outcome: result.outcome,
        errors: result.trace.filter(({ event }) => event.type === "error"),
      }),
    ).toMatchObject({ status: "succeeded" });
    expect(names(requests[0]!)).toEqual(["discover_tools"]);
    expect(names(requests[1]!)).toEqual(["read", "discover_tools"]);
    expect(requests[2]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("授权读取内容") }),
      ]),
    );
    const records = await store.read(result.runId);
    const declarations = records.filter(
      (record) => (record.payload as Record<string, unknown>).toolDiscoverySelection !== undefined,
    );
    expect(declarations).toHaveLength(2);
    expect(
      (declarations[0]!.payload as Record<string, unknown>).toolDiscoveryCatalog,
    ).toBeDefined();
    expect(
      (declarations[1]!.payload as Record<string, unknown>).toolDiscoveryCatalog,
    ).toBeUndefined();
    expect(result.trace.filter(({ event }) => event.type === "context_prefix")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({
            toolDiscovery: expect.objectContaining({ version: 1, generation: 1, toolCount: 2 }),
          }),
        }),
      ]),
    );
    expect(JSON.stringify(result.trace)).not.toContain("toolDiscoveryCatalog");
  });
});

it("同批发现再猜名不能执行 deferred，下一请求安装后才可用", async () => {
  await scenario(
    async ({ run, requests }) => {
      const result = await run();
      expect(
        result.outcome.status,
        JSON.stringify({ outcome: result.outcome, trace: result.trace, requests }),
      ).toBe("succeeded");
      expect(names(requests[0]!)).toEqual(["discover_tools"]);
      const results = requests[1]!.messages.filter((message) => message.role === "tool");
      expect(
        results.filter((message) => JSON.stringify(message.content).includes("授权读取内容")),
      ).toEqual([]);
      expect(names(requests[1]!)).toEqual(["read", "discover_tools"]);
      expect(JSON.stringify(requests[2]!.messages)).toContain("授权读取内容");
    },
    { guessed: true },
  );
});

it("显式拒绝的工具不进入搜索目录和模型 schema", async () => {
  await scenario(async ({ run, requests }) => {
    const result = await run({
      permissions: { mode: "full", workspaceOnly: true, network: "deny", deny: ["read"] },
    });
    expect(result.outcome.status).toBe("succeeded");
    expect(requests.map(names)).toEqual([
      ["discover_tools"],
      ["discover_tools"],
      ["discover_tools"],
    ]);
    const search = requests[1]!.messages.filter((message) => message.role === "tool");
    expect(JSON.parse(search[0]!.content as string)).toMatchObject({ matches: [] });
    expect(JSON.stringify(requests)).not.toContain("授权读取内容");
  });
});

it("同配置冷恢复保留已确认声明，新的 Run 从未激活目录重新开始", async () => {
  await scenario(
    async ({ run, requests }) => {
      const permissions = {
        mode: "ask" as const,
        allow: ["discover_tools"],
        workspaceOnly: true,
        network: "deny" as const,
      };
      const paused = await run({ permissions });
      expect(paused.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      const resumed = await run(
        { permissions },
        { resumeRunId: paused.runId, approveTool: async () => "allow" },
      );
      expect(resumed.outcome.status, JSON.stringify(resumed.outcome)).toBe("succeeded");
      expect(resumed.runId).toBe(paused.runId);
      expect(names(requests[2]!)).toEqual(["read", "discover_tools"]);
      expect(JSON.stringify(requests[3]!.messages)).toContain("授权读取内容");
    },
    { resumeRead: true },
  );
});

it("静态策略禁止的脚本工具描述不会进入搜索或实际模型请求", async () => {
  await scenario(async ({ run, requests, directory }) => {
    await writeFile(
      path.join(directory, "private-process.mjs"),
      `export default {
      name: "read_private_process", label: "私有进程", description: "机密进程描述样本-783421",
      parameters: { type: "object", properties: {} },
      execute: async () => { throw new Error("不应执行"); }
    };`,
      "utf8",
    );
    const result = await run(
      {
        agents: {
          main: {
            tools: [
              {
                path: "./private-process.mjs",
                exposure: "deferred",
                effect: { operations: ["process"], reversible: false },
              },
            ],
          },
        },
      },
      { approveProjectCode: () => true },
    );
    expect(result.outcome.status).toBe("succeeded");
    expect(requests.map(names)).toEqual([
      ["discover_tools"],
      ["discover_tools"],
      ["discover_tools"],
    ]);
    expect(JSON.stringify(requests)).not.toContain("机密进程描述样本-783421");
  });
});

it("安装的大 schema 先进入真实预算，超限时不发第二请求", async () => {
  await scenario(async ({ run, requests, directory }) => {
    await writeFile(
      path.join(directory, "large-tool.mjs"),
      `export default {
      name: "read_large", label: "大工具", description: "read 大型声明",
      parameters: ${JSON.stringify({
        type: "object",
        properties: {
          value: {
            type: "string",
            enum: Array.from(
              { length: 8000 },
              (_, index) => `value-${index}-large-schema-boundary`,
            ),
          },
        },
      })},
      execute: async () => ({ content: [{ type: "text", text: "不应执行" }], details: {} })
    };`,
      "utf8",
    );
    const result = await run(
      {
        agents: {
          main: {
            systemPrompt: "按需发现",
            tools: [
              {
                path: "./large-tool.mjs",
                exposure: "deferred",
                effect: { operations: ["read"], reversible: true },
              },
            ],
          },
        },
      },
      { approveProjectCode: () => true },
    );
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "context_budget_exhausted",
    });
    expect(requests).toHaveLength(1);
  });
});

it("发现不免除原审批，拒绝 read 不产生成功读取", async () => {
  await scenario(async ({ run, requests }) => {
    const result = await run({
      permissions: {
        mode: "ask",
        allow: ["discover_tools"],
        deny: [],
        workspaceOnly: true,
        network: "deny",
      },
    });
    expect(result.outcome).toMatchObject({
      status: "paused",
      finishReason: "tool_approval_denied",
    });
    expect(requests).toHaveLength(2);
    expect(
      result.trace.some(({ event }) => event.type === "policy_denied" && event.tool === "read"),
    ).toBe(true);
    expect(
      result.trace.some(
        ({ event }) => event.type === "tool_result" && event.tool === "read" && !event.isError,
      ),
    ).toBe(false);
  });
});

it("声明 critical 确认失败时第二请求被阻断", async () => {
  const commit = FileRunStore.prototype.commit;
  const spy = vi
    .spyOn(FileRunStore.prototype, "commit")
    .mockImplementation(function (record, durability) {
      const selection = (record.payload as { toolDiscoverySelection?: { generation: number } })
        .toolDiscoverySelection;
      if (selection?.generation === 1) return Promise.reject(new Error("声明磁盘确认失败"));
      return commit.call(this, record, durability);
    });
  try {
    await scenario(async ({ run, requests }) => {
      const result = await run();
      expect(result.outcome.status).not.toBe("succeeded");
      expect(requests).toHaveLength(1);
    });
  } finally {
    spy.mockRestore();
  }
});

function names(request: Request) {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}

async function scenario(
  verify: (input: {
    requests: Request[];
    directory: string;
    store: FileRunStore;
    run: (
      patch?: Partial<CoreMindConfig>,
      options?: Pick<CoreMindRuntimeOptions, "resumeRunId" | "approveTool" | "approveProjectCode">,
    ) => Promise<Awaited<ReturnType<CoreMindRuntime["run"]>>>;
  }) => Promise<void>,
  settings: { guessed?: boolean; resumeRead?: boolean } = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-"));
  const requests: Request[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(body));
        const reply: Reply =
          requests.length === 1
            ? [
                { name: "discover_tools", args: { query: "read" } },
                ...(settings.guessed ? [{ name: "read", args: { path: "notes.txt" } }] : []),
              ]
            : requests.length === 2 || (settings.resumeRead && requests.length === 3)
              ? [{ name: "read", args: { path: "notes.txt" } }]
              : "完成";
        const delta =
          typeof reply === "string"
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                tool_calls: reply.map((tool, index) => ({
                  index,
                  id: `discovery-${requests.length}-${index}`,
                  type: "function",
                  function: { name: tool.name, arguments: JSON.stringify(tool.args) },
                })),
              };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [change, finish] of [
          [delta, null],
          [{}, typeof reply === "string" ? "stop" : "tool_calls"],
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: `reply-${requests.length}`,
              choices: [{ index: 0, delta: change, finish_reason: finish }],
            })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end();
      }
    });
  });
  try {
    await writeFile(path.join(directory, "notes.txt"), "授权读取内容", "utf8");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const store = new FileRunStore(path.join(directory, ".coremind", "runs"));
    await verify({
      requests,
      store,
      directory,
      run: async (patch = {}, options = {}) => {
        const runtime = await CoreMindRuntime.create({
          config: {
            schemaVersion: 3,
            name: "按需发现验收",
            provider: {
              id: "discovery-probe",
              baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
              model: "probe",
              apiKeyEnv: "COREMIND_TEST_API_KEY",
            },
            agents: {
              main: {
                systemPrompt: "只使用已声明工具",
                tools: [{ id: "read", exposure: "deferred" }],
              },
            },
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
            runtime: {
              maxTurns: 5,
              maxToolCalls: 8,
              maxTokens: 8000,
              maxRetries: 0,
              runTimeoutMs: 15000,
            },
            ...patch,
          },
          configDir: directory,
          cwd: directory,
          initialPrompt: "发现并读取 notes.txt",
          runStore: store,
          ...options,
        });
        return runtime.run();
      },
    });
    expect(failures).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
