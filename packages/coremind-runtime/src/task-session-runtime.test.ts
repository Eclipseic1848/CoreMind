import "../../../test/setup-env.js";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "coremind-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRunStore } from "./run-state.js";
import { type TaskDefinition, type TaskRuntimeOptions, TaskSession } from "./task-session.js";

let workspace: string;
let server: Server | undefined;
let session: TaskSession | undefined;
let requests: number;
let runtime: TaskRuntimeOptions;
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-runtime-"));
  requests = 0;
});
afterEach(async () => {
  await session?.close();
  session = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  await rm(workspace, { recursive: true, force: true });
});

async function serve(reply: (response: ServerResponse, index: number) => void) {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => reply(response, ++requests));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  runtime = {
    authorityVersion: "policy-1",
    configDir: workspace,
    config: validateConfig({
      schemaVersion: 2,
      name: "任务治理夹具",
      defaultAgent: "main",
      provider: {
        id: "local-probe",
        model: "probe",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      },
      agents: { main: {} },
      runtime: { maxTurns: 4, maxRetries: 0, runTimeoutMs: 10_000 },
      permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
    }),
  };
}
function respond(response: ServerResponse, tool?: { name: string; arguments: string }) {
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [{ index: 0, id: "call-1", type: "function", function: tool }],
      }
    : { role: "assistant", content: "完成" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ id: "task", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ id: "task", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}
async function open(handler?: TaskDefinition["phases"][string]) {
  session = await TaskSession.open({
    workspace,
    sessionId: "governance",
    runtime,
    definitions: [
      {
        type: "model",
        version: 1,
        initialPhase: "a",
        checkpointSchema: { type: "string" },
        phases: {
          a:
            handler ??
            (async (context) => {
              const result = await context.run("执行阶段");
              return { phase: "a", checkpoint: result.transcript, done: true };
            }),
        },
      },
    ],
  });
  await session.start({ taskId: "job", type: "model", checkpoint: "initial" });
  return session;
}
async function events(runId: string) {
  const records = await new FileRunStore(path.join(workspace, ".coremind/runs")).read(runId);
  return {
    records,
    events: records
      .filter((record) => record.kind === "event")
      .map((record) => (record.payload as { event: { type: string; status?: string } }).event),
  };
}

describe("任务阶段复用真实 Runtime 治理", () => {
  it("处理器遗漏 await 也必须受同一个阶段超时约束", async () => {
    await serve(() => {});
    runtime.stepTimeoutMs = 80;
    const tasks = await open((context) => {
      void context.run("等待响应");
      return { phase: "a", checkpoint: "未等待", done: true };
    });
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_phase_timeout" });
    expect(tasks.query("job")).toMatchObject({ status: "paused", checkpoint: "initial" });
  });
  it("模型请求经过完整 Run，并写入开始和结束 Facts", async () => {
    await serve((response) => respond(response));
    let runId = "";
    const tasks = await open(async (context) => {
      const result = await context.run("回答");
      runId = result.runId;
      return { phase: "a", checkpoint: result.transcript, done: true };
    });
    expect(await tasks.resume("job")).toMatchObject({ status: "completed", checkpoint: "完成" });
    expect(requests).toBe(1);
    const facts = await events(runId);
    expect(facts.records.map((record) => record.kind)).toEqual(
      expect.arrayContaining(["start", "finish"]),
    );
    expect(tasks.query("job")!.pendingRunId).toBeUndefined();
  });

  it("半小时持久等待在 Run 结束后提交，不延长 Run 或阶段超时", async () => {
    await serve((response) => respond(response));
    let runId = "";
    const tasks = await open(async (context) => {
      const result = await context.run("回答后等待");
      runId = result.runId;
      return { phase: "a", checkpoint: result.transcript, sleepUntil: Date.now() + 1_800_000 };
    });
    expect(await tasks.resume("job")).toMatchObject({ status: "sleeping", checkpoint: "完成" });
    expect(tasks.query("job")!.pendingRunId).toBeUndefined();
    expect(tasks.nextWake()!.remainingMs).toBeGreaterThan(0);
    expect(tasks.nextWake()!.remainingMs).toBeLessThanOrEqual(1_800_000);
    expect((await events(runId)).records.map((record) => record.kind)).toEqual(
      expect.arrayContaining(["start", "finish"]),
    );
    expect(runtime.config.runtime.runTimeoutMs).toBe(10_000);
    await tasks.resume("job");
    expect(requests).toBe(1);
  });

  it("工具审批拒绝保持阶段检查点，不写文件，恢复不重发模型", async () => {
    await serve((response, index) =>
      respond(
        response,
        index === 1
          ? {
              name: "write",
              arguments: JSON.stringify({ path: "denied.txt", content: "禁止写入" }),
            }
          : undefined,
      ),
    );
    runtime.config = validateConfig({ ...runtime.config, tools: [{ id: "write" }] });
    runtime.approveTool = vi.fn(async () => "deny" as const);
    const tasks = await open();
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_run_failed" });
    expect(runtime.approveTool).toHaveBeenCalled();
    expect(existsSync(path.join(workspace, "denied.txt"))).toBe(false);
    const state = tasks.query("job")!;
    expect(state).toMatchObject({ phase: "a", status: "paused", checkpoint: "initial" });
    expect((await events(state.pendingRunId!)).events).toContainEqual(
      expect.objectContaining({ type: "policy_denied" }),
    );
    const count = requests;
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_run_unresolved" });
    expect(requests).toBe(count);
  });

  it("工具预算耗尽不能被阶段处理器吞错后当作成功", async () => {
    await serve((response) =>
      respond(response, { name: "read", arguments: JSON.stringify({ path: "input.txt" }) }),
    );
    writeFileSync(path.join(workspace, "input.txt"), "budget", "utf8");
    runtime.config = validateConfig({
      ...runtime.config,
      tools: [{ id: "read" }],
      runtime: { ...runtime.config.runtime, maxToolCalls: 0 },
    });
    const tasks = await open(async (context) => {
      try {
        await context.run("读取");
      } catch {
        /* 验证吞错不能推进阶段。 */
      }
      return { phase: "a", checkpoint: "伪成功", done: true };
    });
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_run_failed" });
    expect(tasks.query("job")).toMatchObject({ status: "paused", checkpoint: "initial" });
    const facts = await events(tasks.query("job")!.pendingRunId!);
    expect(JSON.stringify(facts.records)).toContain("budget_exceeded");
    expect(requests).toBe(1);
  });

  it("真实外部副作用未知时保留原 Run，不能推进或自动重发", async () => {
    await serve((response, index) =>
      respond(response, index === 1 ? { name: "effect", arguments: "{}" } : undefined),
    );
    const execute = vi.fn(() => {
      writeFileSync(path.join(workspace, "effect.txt"), "已发生", "utf8");
      throw new Error("确认回执前失败");
    });
    runtime.config = validateConfig({
      ...runtime.config,
      permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
    });
    runtime.approveTool = async () => "allow";
    runtime.toolDefinitions = [
      {
        name: "effect",
        description: "外部副作用夹具",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        effect: { operations: ["external"], reversible: false },
        capability: {
          effect: "external",
          replay: "unknown",
          concurrency: "run_serial",
          checkpoint: "unsupported",
          durability: "critical",
        },
        execute,
      },
    ];
    const tasks = await open();
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_run_failed" });
    expect(execute).toHaveBeenCalledOnce();
    expect(existsSync(path.join(workspace, "effect.txt"))).toBe(true);
    const facts = await events(tasks.query("job")!.pendingRunId!);
    expect(facts.events).toContainEqual(
      expect.objectContaining({ type: "effect_receipt", status: "unknown" }),
    );
    await expect(tasks.resume("job")).rejects.toMatchObject({ code: "task_run_unresolved" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("任务取消传递到活动模型 Run，保留终态而不伪造完成", async () => {
    let entered!: () => void;
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await serve(() => entered());
    const tasks = await open();
    const work = tasks.resume("job");
    const rejected = expect(work).rejects.toMatchObject({ code: "task_cancelled" });
    await requested;
    expect(await tasks.cancel("job")).toMatchObject({ status: "cancelled", checkpoint: "initial" });
    await rejected;
    const facts = await events(tasks.query("job")!.pendingRunId!);
    expect(JSON.stringify(facts.records)).toContain("aborted");
  });
});
