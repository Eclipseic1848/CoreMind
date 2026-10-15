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
import { FileRunStore, fingerprintRunConfig, prepareRunResume } from "./run-state.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import type { ToolApprovalRequest } from "./tool-policy.js";

const secret = "runtime-http-private-value-846032";
const businessArgs = { value: { flag: false, count: 0, empty: null } };
type Request = {
  messages: unknown[];
  tools?: Array<{ function: { name: string; description: string; parameters: unknown } }>;
};

it("真实 HTTP 连接、目录、调用都在独立持久屏障后执行，完整 schema 与身份不混入协议参数", async () => {
  await withProject("tool", async (project) => {
    project.config.permissions!.network = "ask";
    const gates = Array.from({ length: 3 }, () => ({ entered: deferred(), release: deferred() }));
    let stage = 0;
    const store = new FileRunStore(path.join(project.directory, "runs"), {
      beforeBarrier: async ({ record }) => {
        const event =
          record?.kind === "event" ? (record.payload as { event: CoreMindEvent }).event : undefined;
        if (event?.type !== "effect_receipt" || event.status !== "started") return;
        const gate = gates[stage++];
        if (!gate) throw new Error("夹具遇到额外的 started 屏障");
        gate.entered.resolve();
        await gate.release.promise;
      },
    });
    const runtime = await create(project, { runStore: store });
    project.running = runtime.run();
    try {
      await waitForGate(gates[0]!.entered.promise, project.running);
      expect(project.service.records.some((record) => record.type === "http")).toBe(false);
      gates[0]!.release.resolve();
      await waitForGate(gates[1]!.entered.promise, project.running);
      expect(methods(project, "initialize")).toHaveLength(1);
      expect(methods(project, "tools/list")).toHaveLength(0);
      gates[1]!.release.resolve();
      await waitForGate(gates[2]!.entered.promise, project.running);
      expect(methods(project, "tools/list")).toHaveLength(1);
      expect(methods(project, "tools/call")).toHaveLength(0);
      expect(project.requests).toHaveLength(1);
      gates[2]!.release.resolve();
      const result = await project.running;
      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
      expect(stage).toBe(3);
      expect(project.approvals).toHaveLength(3);
      const declaration = project.requests[0]!.tools![0]!.function;
      expect(declaration.parameters).toMatchObject({
        $defs: { value: {} },
        properties: { value: { $ref: "#/$defs/value" } },
      });
      const business = project.approvals.find((approval) => approval.tool === declaration.name)!;
      expect(business.args).toMatchObject({
        mcp: { url: project.service.url, tool: "echo" },
        arguments: businessArgs,
      });
      expect(methods(project, "tools/call")[0]!.params).toEqual({
        name: "echo",
        arguments: businessArgs,
      });
      expect(methods(project, "resources/list")).toHaveLength(0);
      expect(methods(project, "resources/read")).toHaveLength(0);
      expect(
        JSON.stringify({ result, requests: project.requests, approvals: project.approvals }),
      ).not.toContain(secret);
      expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => expect(project.service.sockets.size).toBe(0));
    } finally {
      for (const gate of gates) gate.release.resolve();
    }
  });
});

it("仅资源 Agent 的首个模型请求之前没有 HTTP，读取经原 Harness 准入且秘密不外泄", async () => {
  await withProject("resource", async (project) => {
    project.config.permissions!.network = "ask";
    project.onFirstModel = () =>
      expect(project.service.records.some((record) => record.type === "http")).toBe(false);
    const runtime = await create(project);
    project.running = runtime.run();
    const result = await project.running;
    expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
    expect(project.requests[0]!.tools).toHaveLength(3);
    expect(methods(project, "initialize")).toHaveLength(1);
    expect(methods(project, "tools/list")).toHaveLength(0);
    expect(methods(project, "resources/list")).toHaveLength(0);
    expect(methods(project, "resources/read").map((record) => record.params)).toEqual([
      { uri: "fixture://first" },
    ]);
    expect(project.approvals).toHaveLength(2);
    expect(project.approvals[0]!.args).toMatchObject({
      mcp: { operation: "resources/read", resourceUris: ["fixture://first"] },
      arguments: { uri: "fixture://first" },
    });
    expect(
      JSON.stringify({ result, requests: project.requests, approvals: project.approvals }),
    ).not.toContain(secret);
    expect(await runtime.waitForQuiescence()).toBe(true);
    await vi.waitFor(() => expect(project.service.sockets.size).toBe(0));
  });
});

it("同一模型批次首次并行读取两个 HTTP 服务，不争抢连接内部的 Run 租约", async () => {
  await withProject("resource", async (project) => {
    const other = await startMcpHttpServer({ secret });
    try {
      const configured = project.config.mcp!.servers.remote!;
      if (configured.transport !== "streamable-http") throw new Error("夹具服务类型错误");
      project.config.mcp!.servers.other = {
        ...configured,
        url: other.url,
      };
      project.config.agents.main!.mcpResources!.other = ["fixture://first"];
      project.config.permissions!.network = "ask";
      project.parallelResourceReads = true;
      project.onFirstModel = () => {
        for (const service of [project.service, other]) {
          expect(
            service.records.some(
              (record) => record.type === "http" || record.type === "socket-open",
            ),
          ).toBe(false);
        }
      };
      const runtime = await create(project);
      project.running = runtime.run();
      const result = await project.running;
      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
      expect(result.metrics.toolCalls).toBe(4);
      expect(project.requests).toHaveLength(2);
      expect(project.requests[0]!.tools).toHaveLength(6);
      const reads = project.requests[0]!.tools!.filter((tool) =>
        tool.function.description.includes("resources/read"),
      );
      expect(reads).toHaveLength(2);
      expect(new Set(reads.map((tool) => tool.function.name)).size).toBe(2);
      expect(project.approvals).toHaveLength(4);
      const committed = project.observed.filter(
        (event) => event.type === "effect_receipt" && event.status === "committed",
      );
      expect(committed).toHaveLength(4);
      for (const read of reads) {
        expect(committed).toContainEqual(
          expect.objectContaining({ tool: read.function.name, status: "committed" }),
        );
      }
      for (const service of [project.service, other]) {
        const calls = service.records.filter((record) => record.type === "request");
        expect(calls.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(calls.filter((record) => record.method === "resources/read")).toEqual([
          expect.objectContaining({ params: { uri: "fixture://first" } }),
        ]);
        expect(
          calls.some(
            (record) =>
              record.method === "tools/list" ||
              record.method === "resources/list" ||
              record.method === "resources/templates/list",
          ),
        ).toBe(false);
      }
      expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => {
        expect(project.service.sockets.size).toBe(0);
        expect(other.sockets.size).toBe(0);
      });
      expect(
        JSON.stringify({ result, requests: project.requests, approvals: project.approvals }),
      ).not.toContain(secret);
    } finally {
      await other.close();
    }
  });
});

it.each(["tool", "resource"] as const)(
  "网络拒绝时 %s 的实际 HTTP 与 socket 计数均为零",
  async (kind) => {
    await withProject(kind, async (project) => {
      project.config.permissions!.network = "deny";
      const runtime = await create(project);
      project.running = runtime.run();
      const result = await project.running;
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "tool_approval_denied",
      });
      expect(project.observed.some((event) => event.type === "policy_denied")).toBe(true);
      expect(
        project.service.records.some(
          (record) => record.type === "http" || record.type === "socket-open",
        ),
      ).toBe(false);
      expect(project.approvals).toHaveLength(0);
      expect(await runtime.waitForQuiescence()).toBe(true);
    });
  },
);

it.each(["127.1", "2130706433"])(
  "直接 Runtime 的原始 HTTP 主机 %s 不得因 URL 规范化绕过零出站拒绝",
  async (host) => {
    await withProject("tool", async (project) => {
      const server = project.config.mcp!.servers.remote!;
      if (server.transport !== "streamable-http") throw new Error("夹具服务类型错误");
      server.url = project.service.url.replace("127.0.0.1", host);
      const runtime = await create(project);
      project.running = runtime.run();
      const result = await project.running;
      expect(
        project.service.records.filter(
          (record) => record.type === "http" || record.type === "socket-open",
        ),
      ).toEqual([]);
      expect(result.outcome).toMatchObject({
        status: "paused",
        finishReason: "unclassified_error",
        error: { code: "unclassified_error", audit: { originalCode: "mcp_http_policy_denied" } },
      });
      expect(project.requests).toEqual([]);
      expect(await runtime.waitForQuiescence()).toBe(true);
      expect(project.service.sockets.size).toBe(0);
    });
  },
);

it("HTTP 元操作不要求放开工作区；业务 external 声明仍被原工作区硬门拦截", async () => {
  await withProject("tool", async (project) => {
    const tool = project.config.agents.main!.tools![0]!;
    if (!("mcp" in tool)) throw new Error("夹具工具类型错误");
    tool.effect = { operations: ["external"], reversible: false };
    tool.capability = {
      effect: "external",
      replay: "unknown",
      concurrency: "run_serial",
      checkpoint: "unsupported",
      durability: "critical",
    };
    const runtime = await create(project);
    project.running = runtime.run();
    const result = await project.running;
    expect(result.outcome.status).not.toBe("succeeded");
    expect(methods(project, "initialize")).toHaveLength(1);
    expect(methods(project, "tools/list")).toHaveLength(1);
    expect(methods(project, "tools/call")).toHaveLength(0);
    expect(project.observed.some((event) => event.type === "policy_denied")).toBe(true);
  });
});

it("模型猜测资源 URI 不触发惰性连接或远端读取", async () => {
  await withProject("resource", async (project) => {
    project.arguments = { uri: "fixture://unselected" };
    const runtime = await create(project);
    project.running = runtime.run();
    await project.running;
    expect(
      project.service.records.some(
        (record) => record.type === "http" || record.type === "socket-open",
      ),
    ).toBe(false);
    expect(await runtime.waitForQuiescence()).toBe(true);
  });
});

it("远端写后丢响应仅执行一次，unknown 收据持久化且原恢复门不重放", async () => {
  await withProject(
    "tool",
    async (project) => {
      const store = new FileRunStore(path.join(project.directory, "runs"));
      const runtime = await create(project, { runStore: store });
      project.running = runtime.run();
      await project.running;
      expect(methods(project, "tools/call")).toHaveLength(1);
      expect(project.service.records.filter((record) => record.type === "effect")).toHaveLength(1);
      const unknown = project.observed.find(
        (event) => event.type === "effect_receipt" && event.status === "unknown",
      );
      expect(unknown).toBeDefined();
      const result = await project.running;
      const records = await store.read(result.runId);
      const unknownIndex = records.findIndex((record) => {
        const event =
          record.kind === "event" ? (record.payload as { event: CoreMindEvent }).event : undefined;
        return event?.type === "effect_receipt" && event.status === "unknown";
      });
      expect(unknownIndex).toBeGreaterThan(0);
      expect(() =>
        prepareRunResume(records.slice(0, unknownIndex + 1), fingerprintRunConfig(project.config)),
      ).toThrow();
      expect(methods(project, "tools/call")).toHaveLength(1);
      expect(await runtime.waitForQuiescence()).toBe(true);
    },
    "write-drop",
  );
});

it("HTTP 请求实发后用户取消保留 aborted 与同 Call 的 unknown，公开快照和冷读事实一致", async () => {
  await withProject(
    "tool",
    async (project) => {
      const storeDirectory = path.join(project.directory, "runs-cancel");
      const store = new FileRunStore(storeDirectory);
      const runtime = await create(project, { runStore: store });
      project.running = runtime.run();
      await waitForGate(
        vi.waitFor(() => expect(methods(project, "tools/call")).toHaveLength(1), {
          timeout: 3_000,
          interval: 20,
        }),
        project.running,
      );
      const alias = project.requests[0]!.tools![0]!.function.name;
      const call = project.observed.find(
        (event): event is Extract<CoreMindEvent, { type: "tool_call" }> =>
          event.type === "tool_call" && event.tool === alias,
      );
      expect(call?.callId).toBeTypeOf("string");
      expect(project.observed).toContainEqual(
        expect.objectContaining({
          type: "effect_receipt",
          tool: alias,
          callId: call!.callId,
          status: "started",
        }),
      );
      project.controller.abort();
      const result = await project.running;
      expect(result.outcome).toMatchObject({ status: "aborted", finishReason: "aborted" });
      expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => expect(project.service.sockets.size).toBe(0));
      expect(methods(project, "tools/call")).toEqual([
        expect.objectContaining({ params: { name: "echo", arguments: businessArgs } }),
      ]);
      expect(project.requests).toHaveLength(1);
      const records = await new FileRunStore(storeDirectory).read(result.runId);
      const projection = ProjectionEngine.project(records);
      expect(projection.status).toBe("finished");
      expect(projection.outcome).toEqual(result.outcome);
      expect(projection.snapshot).toEqual(result.snapshot);
      expect(projection.trace).toEqual(result.trace);
      expect(result.snapshot.outcome).toEqual(result.outcome);
      expect(result.snapshot.trace).toEqual(result.trace);
      const receipts = projection.trace
        .map((entry) => entry.event)
        .filter(
          (event): event is Extract<CoreMindEvent, { type: "effect_receipt" }> =>
            event.type === "effect_receipt" && event.callId === call!.callId,
        );
      expect(receipts.map((event) => event.status)).toEqual(["started", "unknown"]);
      expect(receipts.every((event) => event.tool === alias)).toBe(true);
      const unknownIndex = records.findIndex((record) => {
        const event =
          record.kind === "event" ? (record.payload as { event: CoreMindEvent }).event : undefined;
        return (
          event?.type === "effect_receipt" &&
          event.callId === call!.callId &&
          event.status === "unknown"
        );
      });
      expect(unknownIndex).toBeGreaterThan(0);
      // 连接先提交；沿原恢复门拒绝连续崩溃前缀，不能替 MCP 伪造更宽的恢复理由。
      expect(() =>
        prepareRunResume(records.slice(0, unknownIndex + 1), fingerprintRunConfig(project.config)),
      ).toThrowError(expect.objectContaining({ code: "committed_effect_pending" }));
      expect(await store.read(result.runId)).toEqual(records);
      expect(methods(project, "tools/call")).toHaveLength(1);
      expect(project.requests).toHaveLength(1);
      expect(projection.trace.some((entry) => entry.event.type === "quiescence_timeout")).toBe(
        false,
      );
      expect(JSON.stringify({ result, projection, records })).not.toContain(secret);
    },
    "hang-call",
  );
});

function methods(project: Project, method: string) {
  return project.service.records.filter(
    (record) => record.type === "request" && record.method === method,
  );
}

type Project = {
  service: Awaited<ReturnType<typeof startMcpHttpServer>>;
  directory: string;
  config: CoreMindConfig;
  requests: Request[];
  observed: CoreMindEvent[];
  approvals: ToolApprovalRequest[];
  controller: AbortController;
  arguments: Record<string, unknown>;
  parallelResourceReads?: boolean;
  onFirstModel?: () => void;
  running?: Promise<RunResult>;
};

async function create(
  project: Project,
  extra: Partial<Parameters<typeof CoreMindRuntime.create>[0]> = {},
) {
  return CoreMindRuntime.create({
    config: project.config,
    configDir: project.directory,
    cwd: project.directory,
    env: {
      ...process.env,
      COREMIND_TEST_API_KEY: "offline-test-only",
      MCP_TEST_SECRET: `Bearer ${secret}`,
    },
    signal: project.controller.signal,
    initialPrompt: "调用当前已授权工具",
    events: (event) => project.observed.push(event),
    approveTool: async (request) => {
      project.approvals.push(request);
      return "allow";
    },
    ...extra,
  });
}

async function withProject(
  kind: "tool" | "resource",
  action: (project: Project) => Promise<void>,
  mode = "normal",
) {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-http-runtime-"));
  const service = await startMcpHttpServer({ mode, secret });
  const errors: unknown[] = [];
  const requests: Request[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body) as Request;
        requests.push(parsed);
        if (requests.length === 1) project.onFirstModel?.();
        const selected =
          parsed.tools?.filter((item) =>
            kind === "resource"
              ? item.function.description.includes("resources/read")
              : item.function.name.startsWith("mcp_"),
          ) ?? [];
        const tools = project.parallelResourceReads ? selected : selected.slice(0, 1);
        const calling = requests.length === 1 && tools.length > 0;
        const delta = calling
          ? {
              role: "assistant",
              tool_calls: tools.map((tool, index) => ({
                index,
                id: `http-business-call-${index}`,
                type: "function",
                function: {
                  name: tool.function.name,
                  arguments: JSON.stringify(project.arguments),
                },
              })),
            }
          : { role: "assistant", content: "HTTP 工具验收完成" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [content, reason] of [
          [delta, null],
          [{}, calling ? "tool_calls" : "stop"],
        ])
          response.write(
            `data: ${JSON.stringify({ id: `http-${requests.length}`, choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
          );
        response.end("data: [DONE]\n\n");
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const project: Project = {
    directory,
    service,
    requests,
    observed: [],
    approvals: [],
    controller: new AbortController(),
    arguments: kind === "resource" ? { uri: "fixture://first" } : businessArgs,
    config: {
      schemaVersion: 2,
      name: "HTTP MCP 真实验收",
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
            headers: { Authorization: { env: "MCP_TEST_SECRET" } },
          },
        },
      },
      agents: {
        main:
          kind === "resource"
            ? { mcpResources: { remote: ["fixture://first"] } }
            : {
                tools: [
                  {
                    mcp: { server: "remote", tool: "echo" },
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
      runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 5, runTimeoutMs: 10_000 },
    },
  };
  try {
    await action(project);
    expect(errors).toEqual([]);
  } finally {
    project.controller.abort();
    service.release();
    await project.running?.catch(() => {});
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForGate(entered: Promise<void>, running: Promise<RunResult>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      running.then((result) => {
        throw new Error(`屏障前已终止：${JSON.stringify(result.outcome)}`);
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("没有到达预期屏障")), 4_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
