import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
        capabilities: expect.arrayContaining(["loop", "runSnapshot"]),
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

    expect(inspected).toMatchObject({
      result: { status: "finished", checkpoints: [{ checkpointId: checkpoint!.checkpointId }] },
    });
    expect(diff).toMatchObject({
      result: { changed: true, beforeText: "修改前", afterText: "修改后" },
    });
    expect(restored).toMatchObject({ result: { restored: true } });
    expect(readFileSync(target, "utf8")).toBe("修改前");
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
