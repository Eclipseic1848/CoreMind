import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { CheckpointManager, FileRunStore, RunStateJournal } from "coremind-ai";
import { PROTOCOL_VERSION } from "coremind-protocol";
import { describe, expect, it } from "vitest";
import { type WorkerRuntimeFactory, WorkerServer } from "./server.js";

describe("WorkerServer", () => {
  it("初始化后运行同一个 CoreMind Runtime，并把 Map 转为跨语言对象", async () => {
    const sent: unknown[] = [];
    const factory: WorkerRuntimeFactory = async (options) => ({
      run: async () => {
        const entry = {
          eventId: "event-1",
          runId: "run-1",
          sequence: 1,
          timestamp: "2026-08-07T00:00:00.000Z",
          event: { type: "agent_start" as const, agent: "main" },
        };
        options.trace?.(entry);
        return successfulResult(entry);
      },
    });
    const server = new WorkerServer({
      send: (message) => sent.push(message),
      runtimeFactory: factory,
    });

    const initialized = await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "run",
      params: { input: "执行" },
    });

    expect(initialized).toMatchObject({
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: expect.arrayContaining([
          "loop",
          "runSnapshot",
          "localObservability",
          "telemetryProjection",
        ]),
      },
    });
    expect(sent).toContainEqual(
      expect.objectContaining({
        method: "event",
        params: expect.objectContaining({ runId: "run-1" }),
      }),
    );
    expect(response).toMatchObject({
      result: {
        runId: "run-1",
        outcome: { status: "succeeded" },
        snapshot: {
          schemaVersion: 1,
          runId: "run-1",
          operation: { state: "completed" },
          outcome: { status: "succeeded" },
          resumable: false,
        },
        outputs: { answer: { text: "完成" } },
        messages: { main: [] },
        observability: {
          localEnabled: true,
          telemetry: { mode: "DISABLED" },
        },
      },
    });
  });

  it("Python 工具通知与 tool_result 在同一常驻进程内往返", async () => {
    const sent: Array<any> = [];
    const factory: WorkerRuntimeFactory = async (options) => ({
      run: async () => {
        const entry = {
          eventId: "event-1",
          runId: "run-tool",
          sequence: 1,
          timestamp: "2026-08-07T00:00:00.000Z",
          event: { type: "agent_start" as const, agent: "main" },
        };
        options.trace?.(entry);
        const value = await options.toolDefinitions![0]!.execute(
          { orderId: "A-1" },
          { callId: "call-1" },
        );
        return { ...successfulResult(entry), transcript: JSON.stringify(value) };
      },
    });
    const server = new WorkerServer({
      send: (message) => sent.push(message),
      runtimeFactory: factory,
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "register_tool",
      params: {
        name: "lookup_order",
        description: "查询订单",
        parameters: { type: "object", properties: { orderId: { type: "string" } } },
        effect: { operations: ["read"], reversible: true },
      },
    });

    const runPromise = server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "run",
      params: { input: "查询" },
    });
    await waitUntil(() => sent.some((message) => message.method === "python_tool_call"));
    await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "tool_result",
      params: { callId: "call-1", result: { status: "paid" } },
    });
    const response = await runPromise;

    expect(sent).toContainEqual(
      expect.objectContaining({
        method: "python_tool_call",
        params: expect.objectContaining({ tool: "lookup_order", callId: "call-1" }),
      }),
    );
    expect(response).toMatchObject({ result: { transcript: '{"status":"paid"}' } });
  });

  it("Python 工具经真实 Runtime Harness 后才进入 Worker Adapter", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-worker-python-harness-"));
    const provider = createPythonToolCallingServer();
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const sent: Array<any> = [];
    let notifyPythonToolCall!: () => void;
    const pythonToolCall = new Promise<void>((resolve) => {
      notifyPythonToolCall = resolve;
    });
    const server = new WorkerServer({
      send: (message) => {
        sent.push(message);
        if ("method" in message && message.method === "python_tool_call") notifyPythonToolCall();
      },
    });
    let runPromise: ReturnType<WorkerServer["handle"]> | undefined;

    try {
      const port = (provider.address() as AddressInfo).port;
      await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          config: {
            schemaVersion: 2,
            name: "Python Harness 入口测试",
            provider: {
              id: "probe",
              baseUrl: `http://127.0.0.1:${port}/v1`,
              model: "probe-model",
              apiKey: "test-key",
            },
            agents: { main: { systemPrompt: "调用 python_probe" } },
            permissions: { mode: "full", workspaceOnly: true, network: "deny" },
          },
          configDir: directory,
          cwd: directory,
        },
      });
      await server.handle({
        jsonrpc: "2.0",
        id: 2,
        method: "register_tool",
        params: {
          name: "python_probe",
          description: "验证 Python Adapter 入口",
          parameters: { type: "object", properties: { value: { type: "string" } } },
          effect: { operations: ["read"], reversible: true },
        },
      });

      runPromise = server.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "run",
        params: { input: "调用 python_probe" },
      });
      await withTimeout(pythonToolCall, 5_000, "等待 Python Tool Adapter 通知超时");
      const adapterIndex = sent.findIndex((message) => message.method === "python_tool_call");
      const executingIndex = sent.findIndex(
        (message) =>
          message.method === "event" &&
          message.params?.event?.type === "tool_lifecycle" &&
          message.params.event.tool === "python_probe" &&
          message.params.event.resolution?.phase === "executing" &&
          message.params.event.resolution?.status === "completed",
      );

      expect(executingIndex).toBeGreaterThanOrEqual(0);
      expect(adapterIndex).toBeGreaterThan(executingIndex);
      expect(sent[adapterIndex]).toMatchObject({
        params: { tool: "python_probe", callId: "python-harness-call", args: { value: "ok" } },
      });

      await server.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tool_result",
        params: { callId: "python-harness-call", result: { accepted: true } },
      });
      await expect(runPromise).resolves.toMatchObject({
        result: { outcome: { status: "succeeded" }, transcript: "Python 工具完成" },
      });
    } finally {
      await server.handle({ jsonrpc: "2.0", id: 5, method: "close", params: {} });
      if (runPromise) await runPromise;
      await new Promise<void>((resolve, reject) => {
        provider.close((error) => (error ? reject(error) : resolve()));
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("通过 resume_run 把中断 runId 交给同一 Runtime", async () => {
    let receivedResumeRunId: string | undefined;
    const factory: WorkerRuntimeFactory = async (options) => {
      receivedResumeRunId = options.resumeRunId;
      return {
        run: async () =>
          successfulResult({
            eventId: "resume-event",
            runId: options.resumeRunId ?? "missing",
            sequence: 2,
            timestamp: "2026-08-08T00:00:00.000Z",
            event: { type: "step_resumed", stepId: "s1" },
          }),
      };
    };
    const server = new WorkerServer({ send: () => {}, runtimeFactory: factory });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "resume_run",
      params: { runId: "interrupted-run", input: "原始输入" },
    });

    expect(receivedResumeRunId).toBe("interrupted-run");
    expect(response).toMatchObject({ result: { runId: "interrupted-run" } });
  });

  it("通过协议检查 RunState、查看 diff 并在显式确认后恢复 checkpoint", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-worker-inspect-"));
    const target = path.join(directory, "notes.txt");
    writeFileSync(target, "修改前", "utf8");
    const checkpoints = new CheckpointManager({
      cwd: directory,
      rootDir: path.join(directory, ".coremind", "checkpoints"),
      runId: "run-inspect",
    });
    const checkpoint = await checkpoints.capture("edit", { path: "notes.txt" });
    writeFileSync(target, "修改后", "utf8");
    await checkpoints.markApplied(checkpoint!.checkpointId);
    const journal = new RunStateJournal(
      "run-inspect",
      new FileRunStore(path.join(directory, ".coremind", "runs")),
    );
    await journal.start({ configName: "demo" });
    journal.checkpoint(checkpoint);
    journal.finish({ outcome: { status: "succeeded", finishReason: "completed" } });
    await journal.flush();
    const server = new WorkerServer({ send: () => {} });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: directory,
        cwd: directory,
      },
    });

    const inspected = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "inspect_run",
      params: { runId: "run-inspect" },
    });
    const diff = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "checkpoint_diff",
      params: { runId: "run-inspect", checkpointId: checkpoint!.checkpointId },
    });
    const restored = await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "checkpoint_restore",
      params: { runId: "run-inspect", checkpointId: checkpoint!.checkpointId, confirm: true },
    });
    const factsPath = new FileRunStore(path.join(directory, ".coremind", "runs")).pathFor!(
      "run-inspect",
    );
    const factsBeforeFailedQuery = readFileSync(factsPath, "utf8");
    const missing = await server.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "inspect_run",
      params: { runId: "run-missing" },
    });
    await server.handle({ jsonrpc: "2.0", id: 6, method: "close" });

    expect(inspected).toMatchObject({
      result: {
        schemaVersion: 1,
        status: "finished",
        recovery: { resumable: false },
        resumable: false,
        checkpoints: [{ checkpointId: checkpoint!.checkpointId }],
        trace: [],
        observability: {
          localEnabled: true,
          derivedFromSequence: 3,
          telemetry: { mode: "DISABLED", exporterLoaded: false },
        },
      },
    });
    expect(diff).toMatchObject({
      result: { changed: true, beforeText: "修改前", afterText: "修改后" },
    });
    expect(restored).toMatchObject({ result: { restored: true } });
    expect(missing).toMatchObject({ error: { data: { coremindCode: "unknown_run" } } });
    expect(readFileSync(factsPath, "utf8")).toBe(factsBeforeFailedQuery);
    expect(readFileSync(target, "utf8")).toBe("修改前");
  });

  it("两个真实 Worker 并发运行时 RunContext、Fact 与 Projection 互不串扰", async () => {
    const provider = createEchoProviderServer();
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const port = (provider.address() as AddressInfo).port;
    const firstDirectory = mkdtempSync(path.join(tmpdir(), "coremind-worker-concurrent-a-"));
    const secondDirectory = mkdtempSync(path.join(tmpdir(), "coremind-worker-concurrent-b-"));
    const first = new WorkerServer({ send: () => {} });
    const second = new WorkerServer({ send: () => {} });
    const config = {
      schemaVersion: 2 as const,
      name: "Worker 并发隔离",
      provider: {
        id: "probe",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "probe-model",
        apiKey: "test-key",
      },
      agents: { main: { systemPrompt: "测试助手" } },
    };
    try {
      await Promise.all([
        first.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, config, configDir: firstDirectory },
        }),
        second.handle({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, config, configDir: secondDirectory },
        }),
      ]);

      const [firstRun, secondRun] = await Promise.all([
        first.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "run",
          params: { input: "任务-A", runId: "worker-run-a" },
        }),
        second.handle({
          jsonrpc: "2.0",
          id: 2,
          method: "run",
          params: { input: "任务-B", runId: "worker-run-b" },
        }),
      ]);
      const firstProjection = await first.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "inspect_run",
        params: { runId: "worker-run-a" },
      });
      const secondProjection = await second.handle({
        jsonrpc: "2.0",
        id: 3,
        method: "inspect_run",
        params: { runId: "worker-run-b" },
      });

      expect(firstRun).toMatchObject({
        result: { runId: "worker-run-a", transcript: "回复：任务-A" },
      });
      expect(secondRun).toMatchObject({
        result: { runId: "worker-run-b", transcript: "回复：任务-B" },
      });
      expect(firstProjection).toMatchObject({
        result: { runId: "worker-run-a", snapshot: { runId: "worker-run-a" } },
      });
      expect(secondProjection).toMatchObject({
        result: { runId: "worker-run-b", snapshot: { runId: "worker-run-b" } },
      });
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => provider.close(() => resolve())),
        first.handle({ jsonrpc: "2.0", id: 4, method: "close" }).then(() => undefined),
        second.handle({ jsonrpc: "2.0", id: 4, method: "close" }).then(() => undefined),
      ]);
    }
  });

  it("inspect_run 明确区分可恢复的暂停运行", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-worker-paused-"));
    const journal = new RunStateJournal(
      "run-paused",
      new FileRunStore(path.join(directory, ".coremind", "runs")),
    );
    await journal.start({ configName: "demo" });
    journal.pause({ outcome: { status: "paused", finishReason: "loop_paused" } });
    await journal.flush();
    const server = new WorkerServer({ send: () => {} });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: directory,
      },
    });

    const inspected = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "inspect_run",
      params: { runId: "run-paused" },
    });

    expect(inspected).toMatchObject({
      result: {
        status: "paused",
        resumable: true,
        outcome: { status: "paused", finishReason: "loop_paused" },
      },
    });
  });

  it("inspect_run 对未稳定提交的副作用复用 Runtime 安全门", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-worker-unsafe-resume-"));
    const journal = new RunStateJournal(
      "run-unsafe",
      new FileRunStore(path.join(directory, ".coremind", "runs")),
    );
    await journal.start({ configName: "demo" });
    journal.event({
      eventId: "event-1",
      runId: "run-unsafe",
      sequence: 1,
      timestamp: "2026-08-23T00:00:00.000Z",
      event: {
        type: "capability_resolved",
        agent: "main",
        tool: "write",
        callId: "call-write",
        capability: {
          tool: "write",
          effect: "workspace",
          replay: "idempotent",
          concurrency: "workspace_exclusive",
          checkpoint: "required",
          durability: "critical",
          source: "builtin",
          resolution: "resolved",
          issues: [],
        },
        recoveryDisposition: "requires_proof",
      },
    });
    journal.event({
      eventId: "event-2",
      runId: "run-unsafe",
      sequence: 2,
      timestamp: "2026-08-23T00:00:01.000Z",
      event: {
        type: "tool_call",
        agent: "main",
        tool: "write",
        args: { path: "notes.txt" },
        callId: "call-write",
        idempotencyKey: "run-unsafe:call-write",
      },
    });
    journal.event({
      eventId: "event-3",
      runId: "run-unsafe",
      sequence: 3,
      timestamp: "2026-08-23T00:00:02.000Z",
      event: {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "run-unsafe:call-write",
        status: "committed",
      },
    });
    journal.pause({ outcome: { status: "paused", finishReason: "interrupted" } });
    await journal.flush();

    const server = new WorkerServer({ send: () => {} });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: directory,
      },
    });

    const inspected = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "inspect_run",
      params: { runId: "run-unsafe" },
    });

    expect(inspected).toMatchObject({
      result: { status: "paused", resumable: false },
    });
  });

  it("run 请求带预生成 runId 时传给 Runtime；不带时保持向后兼容", async () => {
    const sent: unknown[] = [];
    const receivedRunIds: Array<string | undefined> = [];
    const factory: WorkerRuntimeFactory = async (options) => {
      receivedRunIds.push(options.runId);
      return {
        run: async () => {
          const entry = {
            eventId: "event-1",
            runId: "run-1",
            sequence: 1,
            timestamp: "2026-08-07T00:00:00.000Z",
            event: { type: "agent_start" as const, agent: "main" },
          };
          options.trace?.(entry);
          return successfulResult(entry);
        },
      };
    };
    const server = new WorkerServer({
      send: (message) => sent.push(message),
      runtimeFactory: factory,
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "run",
      params: { input: "执行", runId: "client-run-123" },
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "run",
      params: { input: "执行" },
    });

    expect(receivedRunIds).toEqual(["client-run-123", undefined]);
  });

  it("预生成 runId 支持首事件前 cancel（D-1）", async () => {
    const sent: unknown[] = [];
    let cancelled = false;
    const factory: WorkerRuntimeFactory = async (options) => ({
      run: async () => {
        // 首事件前：不发任何 trace 事件，挂起等待取消
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => {
            cancelled = true;
            resolve();
          });
        });
        throw new Error("cancelled");
      },
    });
    const server = new WorkerServer({
      send: (message) => sent.push(message),
      runtimeFactory: factory,
    });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    const runPromise = server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "run",
      params: { input: "执行", runId: "pre-cancel-1" },
    });
    // 等 run 挂起后（首事件前）用预生成 runId 取消
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const cancelledResponse = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "cancel",
      params: { runId: "pre-cancel-1" },
    });

    expect(cancelledResponse).toMatchObject({ result: { cancelled: true } });
    expect(cancelled).toBe(true);
    await runPromise;
  });

  it("close 必须等待在飞 Runtime 完成异步清理后才确认 closed", async () => {
    let entered = false;
    let cleanupFinished = false;
    const factory: WorkerRuntimeFactory = async (options) => ({
      run: async () => {
        entered = true;
        await new Promise<void>((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                cleanupFinished = true;
                resolve();
              }, 20);
            },
            { once: true },
          );
        });
        return successfulResult({
          eventId: "worker-close-event",
          runId: "worker-close-run",
          sequence: 1,
          timestamp: "2026-08-26T00:00:00.000Z",
          event: { type: "agent_start", agent: "main" },
        });
      },
    });
    const server = new WorkerServer({ send: () => {}, runtimeFactory: factory });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });
    const running = server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "run",
      params: { input: "执行", runId: "worker-close-run" },
    });
    await waitUntil(() => entered);

    const closed = await server.handle({ jsonrpc: "2.0", id: 3, method: "close", params: {} });

    expect(closed).toMatchObject({ result: { closed: true, quiescent: true } });
    expect(cleanupFinished).toBe(true);
    await running;
  });

  it("首事件前用不匹配 runId 取消被拒绝（unknown_run）", async () => {
    const factory: WorkerRuntimeFactory = async (options) => ({
      run: async () =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const server = new WorkerServer({ send: () => {}, runtimeFactory: factory });
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        config: { schemaVersion: 2, name: "demo", agents: { main: {} } },
        configDir: ".",
      },
    });

    const runPromise = server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "run",
      params: { input: "执行", runId: "pre-cancel-2" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "cancel",
      params: { runId: "other-run" },
    });

    expect(response).toMatchObject({ error: { data: { coremindCode: "unknown_run" } } });
    // 清理：取消挂起的 run（用正确 runId）
    await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "cancel",
      params: { runId: "pre-cancel-2" },
    });
    await runPromise;
  });
});

function successfulResult(entry: any) {
  const result = {
    runId: entry.runId,
    operation: {
      schemaVersion: 1 as const,
      operationId: `operation-${entry.runId}`,
      runId: entry.runId,
      correlationId: `${entry.runId}:operation-${entry.runId}`,
      state: "completed" as const,
      transitionSequence: 3,
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:01.000Z",
    },
    outcome: { status: "succeeded" as const, finishReason: "completed" },
    metrics: {
      durationMs: 1,
      turns: 1,
      steps: { total: 0, succeeded: 0, failed: 0 },
      toolCalls: 0,
      toolFailures: 0,
      retries: 0,
      outputChars: 2,
    },
    evaluation: {
      profile: "standard" as const,
      scenarioResults: [],
      qualityScores: {},
      securityFindings: [],
    },
    releaseReadiness: { ready: false, blockers: ["尚未执行场景评测"], warnings: [] },
    trace: [entry],
    outputs: new Map([["answer", { text: "完成", metadata: { agent: "main", stepId: "s1" } }]]),
    messages: new Map([["main", []]]),
    transcript: "完成",
    checkpoints: [],
    observability: {
      schemaVersion: 1 as const,
      localEnabled: true as const,
      derivedFromSequence: 3,
      run: { status: "finished" as const, resumable: false },
      turns: { started: 1, completed: 1, active: 0 },
      calls: { started: 0, completed: 0, failed: 0, active: 0, durationMs: 0 },
      tools: [],
      errors: [],
      context: { budgets: 1, compactions: 0, failures: 0 },
      artifacts: { stored: 0, blocked: 0 },
      sharedState: { pendingControls: 0 },
      recovery: { resumable: false },
      telemetry: {
        mode: "DISABLED" as const,
        source: "default" as const,
        exporterLoaded: false,
        contentLevel: "metrics_only" as const,
        allowedFields: [],
        queued: 0,
        handedOff: 0,
        failed: 0,
        dropped: 0,
        duplicates: 0,
        shutdownTimedOut: false,
        deliverySemantics: "best_effort_handoff_not_delivery" as const,
        authorizedScopes: [],
      },
    },
  };
  return {
    ...result,
    snapshot: {
      schemaVersion: 1 as const,
      runId: result.runId,
      operation: result.operation,
      outcome: result.outcome,
      metrics: result.metrics,
      evaluation: result.evaluation,
      releaseReadiness: result.releaseReadiness,
      trace: result.trace,
      checkpoints: result.checkpoints,
      artifacts: [],
      extensions: [],
      resumable: false,
    },
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("等待条件超时");
}

function createPythonToolCallingServer() {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const messages = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
      if (messages.some((message) => message.role === "tool")) {
        sendPythonSse(response, [
          {
            id: "python-final",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Python 工具完成" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "python-final",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]);
        return;
      }
      sendPythonSse(response, [
        {
          id: "python-tool",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "python-harness-call",
                    type: "function",
                    function: { name: "python_probe", arguments: '{"value":"ok"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: "python-tool",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        },
      ]);
    });
  });
}

function createEchoProviderServer() {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      JSON.parse(body);
      const input = body.includes("任务-A")
        ? "任务-A"
        : body.includes("任务-B")
          ? "任务-B"
          : undefined;
      sendPythonSse(response, [
        {
          id: "worker-concurrent",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: `回复：${input ?? "未知"}` },
              finish_reason: null,
            },
          ],
        },
        {
          id: "worker-concurrent",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]);
    });
  });
}

function sendPythonSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
