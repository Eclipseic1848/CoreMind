import "../../../test/setup-env.js";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";
import type { CoreMindEvent } from "./events.js";
import { ProjectionEngine } from "./projection.js";
import { FileRunStore, type FileRunStoreOptions } from "./run-state.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import { ToolDiscoveryExecution } from "./tool-discovery.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

interface Request {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string; description: string; parameters: unknown } }>;
}
type Reply = string | Array<{ name: string; args: unknown }>;
const args = { value: "受控回显正文" };

it("真实目录通知先撤回未安装来源，后续搜索和声明都不复活它", async () => {
  await scenario(async (project) => {
    project.reply = async (_request, ordinal) => {
      if (ordinal === 1) {
        await project.withdraw();
        return [{ name: "discover_tools", args: { query: "回显" } }];
      }
      return "完成";
    };
    const result = await project.run();
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
    expect(project.requests.map(names)).toEqual([["discover_tools"], ["discover_tools"]]);
    expect(lastSearch(project.requests[1]!)).toMatchObject({ matches: [], truncated: false });
    expect(methods(project, "tools/call")).toEqual([]);
    const selections = await selectionFacts(project, result.runId);
    expect(selections.map((selection) => selection.generation)).toEqual([0, 1]);
    expect(selections[1]!.withdrawnSources).toHaveLength(1);
    expect(selections[1]!.names).toEqual([]);
  });
});

it("已安装工具收到真实通知后先同步失效，下一请求持久去声明", async () => {
  await scenario(async (project) => {
    let alias = "";
    project.reply = async (request, ordinal) => {
      if (ordinal === 1) return [{ name: "discover_tools", args: { query: "回显" } }];
      if (ordinal === 2) {
        alias = businessName(request);
        await project.withdraw();
        return [{ name: "discover_tools", args: { query: alias } }];
      }
      return "完成";
    };
    const result = await project.run();
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
    expect(names(project.requests[1]!)).toContain(alias);
    expect(names(project.requests[2]!)).toEqual(["discover_tools"]);
    expect(lastSearch(project.requests[2]!)).toMatchObject({ matches: [], truncated: false });
    expect(methods(project, "tools/call")).toEqual([]);
    const selections = await selectionFacts(project, result.runId);
    expect(selections.map((selection) => selection.generation)).toEqual([0, 1, 2]);
    expect(selections[2]!.names).toEqual([]);
    expect(selections[2]!.withdrawnSources).toHaveLength(1);
  });
});

it("排队审批期间目录变化使旧批准失效；新 Run 重新准备完整 schema 与审批身份", async () => {
  await scenario(async (project) => {
    project.config.permissions!.network = "ask";
    let changed = false;
    project.approve = async (request) => {
      if (isBusiness(request.tool) && !changed) {
        changed = true;
        project.service.changeSchema({
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        });
        await project.withdraw();
      }
      return "allow";
    };
    const rejected = await project.run();
    expect(changed).toBe(true);
    expect(methods(project, "tools/call")).toEqual([]);
    const oldApproval = project.approvals.find((request) => isBusiness(request.tool))!;
    expect(oldApproval).toBeDefined();
    expect(receipts(rejected, oldApproval.tool).map((event) => event.status)).toEqual([
      "not_started",
    ]);
    expect(rejected.outcome.error).toMatchObject({ code: "tool_capability_conflict" });

    const requestOffset = project.requests.length;
    const approvalOffset = project.approvals.length;
    const accepted = await project.run();
    expect(accepted.runId).not.toBe(rejected.runId);
    expect(accepted.outcome.status, JSON.stringify(accepted.outcome)).toBe("succeeded");
    expect(names(project.requests[requestOffset]!)).toEqual(["discover_tools"]);
    const newApproval = project.approvals
      .slice(approvalOffset)
      .find((request) => isBusiness(request.tool))!;
    expect(newApproval).toBeDefined();
    expect(newApproval.tool).not.toBe(oldApproval.tool);
    expect(newApproval.argumentsFingerprint).not.toBe(oldApproval.argumentsFingerprint);
    expect(
      project.requests[requestOffset + 1]!.tools!.find(
        (tool) => tool.function.name === newApproval.tool,
      )?.function.parameters,
    ).toMatchObject({ properties: { value: { type: "string" } } });
    expect(methods(project, "initialize")).toHaveLength(2);
    expect(methods(project, "tools/list")).toHaveLength(2);
    expect(methods(project, "tools/call")).toEqual([
      expect.objectContaining({ params: { name: "echo", arguments: args } }),
    ]);
    expect(receipts(accepted, newApproval.tool).map((event) => event.status)).toEqual([
      "started",
      "committed",
    ]);
  });
});

it("started 持久屏障内收到目录撤回时 Adapter 零调用，同 Call 保守保留 unknown", async () => {
  await scenario(async (project) => {
    project.config.permissions!.network = "ask";
    let crossedStarted = false;
    project.storeOptions = {
      beforeBarrier: async ({ record }) => {
        const event =
          record?.kind === "event"
            ? (record.payload as { event?: CoreMindEvent }).event
            : undefined;
        if (
          event?.type === "effect_receipt" &&
          isBusiness(event.tool) &&
          event.status === "started"
        ) {
          crossedStarted = true;
          expect(methods(project, "tools/call")).toEqual([]);
          await project.withdraw();
        }
      },
    };
    const result = await project.run();
    expect(crossedStarted).toBe(true);
    const approval = project.approvals.find((request) => isBusiness(request.tool))!;
    expect(approval).toBeDefined();
    expect(methods(project, "tools/call")).toEqual([]);
    const actual = receipts(result, approval.tool);
    expect(actual.map((event) => event.status)).toEqual(["started", "unknown"]);
    expect(new Set(actual.map((event) => event.callId)).size).toBe(1);
    expect(result.outcome.error).toMatchObject({ code: "tool_capability_conflict" });
    const records = await new FileRunStore(project.storeDirectory).read(result.runId);
    const projection = ProjectionEngine.project(records);
    expect(projection.outcome).toEqual(result.outcome);
    expect(projection.trace).toEqual(result.trace);
    expect(
      receipts({ trace: projection.trace }, approval.tool).map((event) => event.status),
    ).toEqual(["started", "unknown"]);
  });
});

it("不同 Agent 的新 Run 只查自己的授权目录，不继承另一个 Agent 的 MCP 安装", async () => {
  await scenario(async (project) => {
    project.config.agents.other = {
      systemPrompt: "你是隔离目录 Agent",
      tools: [{ id: "read", exposure: "deferred" }],
    };
    project.reply = (_request, ordinal) =>
      ordinal === 1 ? [{ name: "discover_tools", args: { query: "回显" } }] : "完成";
    const first = await project.run();
    expect(first.outcome.status).toBe("succeeded");
    const alias = businessName(project.requests[1]!);
    project.config.defaultAgent = "other";
    const offset = project.requests.length;
    const other = await project.run();
    expect(other.outcome.status, JSON.stringify(other.outcome)).toBe("succeeded");
    expect(project.requests.slice(offset).map(names)).toEqual([
      ["discover_tools"],
      ["discover_tools"],
    ]);
    expect(lastSearch(project.requests[offset + 1]!)).toMatchObject({
      matches: [],
      truncated: false,
    });
    expect(JSON.stringify(project.requests.slice(offset))).not.toContain(alias);
    expect(methods(project, "initialize")).toHaveLength(1);
    expect(methods(project, "tools/list")).toHaveLength(1);
    expect(methods(project, "tools/call")).toEqual([]);
  });
});

it("真实 Child Run 不继承父 Agent 的已安装 MCP，猜父别名也不创建连接或业务调用", async () => {
  await scenario(async (project) => {
    project.config.permissions = { mode: "full", workspaceOnly: true, network: "allow" };
    project.config.agents.main!.tools!.push({ id: "write", exposure: "deferred" });
    const allocation = {
      tokens: 12_000,
      toolCalls: 4,
      costUsd: 1,
      wallTimeMs: 10_000,
      steps: 4,
      descendants: 0,
    };
    project.config.agents.main!.delegation = {
      budget: { ...allocation, descendants: 1 },
      limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
      targets: { researcher: { budget: allocation } },
    };
    project.config.agents.researcher = {
      systemPrompt: "你是子发现 Agent",
      tools: [{ id: "write", exposure: "deferred" }],
    };
    let alias = "";
    let parentRound = 0;
    let childRound = 0;
    const childRequests: Request[] = [];
    project.reply = (request) => {
      const child = JSON.stringify(
        request.messages.filter((message) => message.role === "system"),
      ).includes("你是子发现 Agent");
      if (child) {
        childRequests.push(request);
        childRound++;
        return childRound === 1
          ? [
              { name: "discover_tools", args: { query: "回显" } },
              { name: alias, args },
            ]
          : "子任务完成";
      }
      parentRound++;
      if (parentRound === 1) return [{ name: "discover_tools", args: { query: "回显" } }];
      if (parentRound === 2) {
        alias = businessName(request);
        return [
          {
            name: "delegate",
            args: {
              target: "researcher",
              task: "仅检查自己目录",
              references: [],
              limits: { ...allocation, maxDepth: 1, maxActiveChildren: 0 },
            },
          },
        ];
      }
      return "父任务完成";
    };
    const result = await project.run();
    expect(
      result.outcome.status,
      JSON.stringify({
        outcome: result.outcome,
        childRuns: result.childRuns,
        parentRound,
        childRound,
        childRequests,
      }),
    ).toBe("succeeded");
    expect(alias).not.toBe("");
    expect(childRequests).toHaveLength(2);
    expect(childRequests.map(names)).toEqual([["discover_tools"], ["discover_tools"]]);
    expect(lastSearch(childRequests[1]!)).toMatchObject({ matches: [], truncated: false });
    expect(result.childRuns?.nodes).toEqual([
      expect.objectContaining({ agentName: "researcher", status: "joined" }),
    ]);
    expect(methods(project, "initialize")).toHaveLength(1);
    expect(methods(project, "tools/list")).toHaveLength(1);
    expect(methods(project, "tools/call")).toEqual([]);
  });
});

function names(request: Request) {
  return request.tools?.map((tool) => tool.function.name) ?? [];
}
function isBusiness(name: string) {
  return name.startsWith("mcp_remote_echo_");
}
function businessName(request: Request) {
  const name = names(request).find(isBusiness);
  if (!name) throw new Error("请求没有声明已安装的 MCP 工具");
  return name;
}
function lastSearch(request: Request) {
  const message = request.messages
    .filter(
      (entry) =>
        entry.role === "tool" &&
        typeof entry.content === "string" &&
        entry.content.includes('"matches"'),
    )
    .at(-1);
  if (!message) throw new Error("请求没有真实发现结果");
  return JSON.parse(message.content as string);
}
function receipts(result: Pick<RunResult, "trace">, tool: string) {
  return result.trace
    .map((entry) => entry.event)
    .filter(
      (event): event is Extract<CoreMindEvent, { type: "effect_receipt" }> =>
        event.type === "effect_receipt" && event.tool === tool,
    );
}
function methods(project: Project, method: string) {
  return project.service.records.filter(
    (entry) => entry.type === "request" && entry.method === method,
  );
}
async function selectionFacts(project: Project, runId: string) {
  const records = await new FileRunStore(project.storeDirectory).read(runId);
  return records.flatMap((record) => {
    const selection = (
      record.payload as {
        toolDiscoverySelection?: {
          generation: number;
          names: string[];
          withdrawnSources: string[];
        };
      }
    ).toolDiscoverySelection;
    return selection ? [selection] : [];
  });
}

interface Project {
  service: Awaited<ReturnType<typeof startMcpHttpServer>>;
  config: CoreMindConfig;
  storeDirectory: string;
  requests: Request[];
  approvals: ToolApprovalRequest[];
  storeOptions?: FileRunStoreOptions;
  reply(request: Request, ordinal: number): Reply | Promise<Reply>;
  approve(request: ToolApprovalRequest): Promise<"allow" | "deny">;
  withdraw(): Promise<void>;
  run(): Promise<RunResult>;
}

async function scenario(verify: (project: Project) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-discovery-mcp-"));
  const service = await startMcpHttpServer({ toolChanges: true });
  const withdraw = vi.spyOn(ToolDiscoveryExecution.prototype, "withdraw");
  const failures: unknown[] = [];
  const controller = new AbortController();
  const runtimes: CoreMindRuntime[] = [];
  const running: Promise<RunResult>[] = [];
  let ordinal = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      void (async () => {
        const parsed = JSON.parse(body) as Request;
        project.requests.push(parsed);
        const reply = await project.reply(parsed, ++ordinal);
        const delta =
          typeof reply === "string"
            ? { role: "assistant", content: reply }
            : {
                role: "assistant",
                tool_calls: reply.map((tool, index) => ({
                  index,
                  id: `discovery-mcp-${ordinal}-${index}`,
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
              id: `reply-${ordinal}`,
              choices: [{ index: 0, delta: change, finish_reason: finish }],
            })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      })().catch((error) => {
        failures.push(error);
        response.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const project: Project = {
    service,
    requests: [],
    approvals: [],
    storeDirectory: path.join(directory, "runs"),
    config: {
      schemaVersion: 3,
      name: "工具发现 MCP 撤回验收",
      provider: {
        id: "probe",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        model: "probe-model",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      mcp: {
        servers: {
          remote: {
            transport: "streamable-http",
            url: service.url,
            allowedAddresses: ["127.0.0.1"],
          },
        },
      },
      agents: {
        main: {
          systemPrompt: "你是父发现 Agent",
          tools: [
            {
              mcp: { server: "remote", tool: "echo" },
              exposure: "deferred",
              effect: { operations: ["network"], reversible: false },
              capability: {
                effect: "network",
                replay: "unknown",
                concurrency: "run_serial",
                checkpoint: "none",
                durability: "critical",
              },
            },
          ],
        },
      },
      permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
      runtime: {
        maxTurns: 6,
        maxSteps: 8,
        maxToolCalls: 12,
        maxTokens: 40_000,
        maxCostUsd: 3,
        maxRetries: 0,
        runTimeoutMs: 15_000,
      },
    },
    reply: (request, round) =>
      round === 1
        ? [{ name: "discover_tools", args: { query: "回显" } }]
        : round === 2
          ? [{ name: businessName(request), args }]
          : "完成",
    approve: async () => "allow",
    withdraw: async () => {
      const before = withdraw.mock.calls.length;
      // 真实通知经传输和 SDK 到达原 Module 方法后，才释放审批或持久屏障。
      await vi.waitFor(() =>
        expect(
          service.records.some((entry) => entry.type === "http" && entry.method === "GET"),
        ).toBe(true),
      );
      service.notifyToolsChanged();
      await vi.waitFor(() => expect(withdraw.mock.calls.length).toBeGreaterThan(before));
    },
    run: async () => {
      ordinal = 0;
      const runtime = await CoreMindRuntime.create({
        config: project.config,
        configDir: directory,
        cwd: directory,
        initialPrompt: "验证已授权的工具目录",
        env: { ...process.env, COREMIND_TEST_API_KEY: "test-only" },
        signal: controller.signal,
        runStore: new FileRunStore(project.storeDirectory, project.storeOptions),
        approveTool: async (request) => {
          project.approvals.push(request);
          return project.approve(request);
        },
      });
      runtimes.push(runtime);
      const promise = runtime.run();
      running.push(promise);
      const result = await promise;
      expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => expect(service.sockets.size).toBe(0));
      return result;
    },
  };
  try {
    await verify(project);
    expect(failures).toEqual([]);
  } finally {
    controller.abort();
    service.release();
    await Promise.allSettled(running);
    await Promise.all(runtimes.map((runtime) => runtime.waitForQuiescence()));
    withdraw.mockRestore();
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
