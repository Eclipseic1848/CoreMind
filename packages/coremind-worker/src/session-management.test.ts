import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig, TaskDefinition } from "coremind-ai";
import { describe, expect, it, type TestContext } from "vitest";
import { ProtocolHost, type WorkerServerOptions } from "./index.js";

// Worker 包的测试只用固定假值，不导入 rootDir 之外的 TypeScript 夹具。
process.env.COREMIND_TEST_API_KEY = "test-only";

const definition: TaskDefinition = {
  type: "demo",
  version: 1,
  initialPhase: "a",
  checkpointSchema: { type: "integer" },
  phases: {
    a: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1, sleepUntil: 0 }),
    b: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1, done: true }),
  },
};
const config: CoreMindConfig = {
  schemaVersion: 2,
  name: "跨语言管理",
  defaultAgent: "main",
  agents: { main: {} },
  provider: {
    id: "probe",
    model: "probe",
    apiKeyEnv: "COREMIND_TEST_API_KEY",
    baseUrl: "http://127.0.0.1:1/v1",
  },
  permissions: { mode: "ask", network: "deny", workspaceOnly: true },
  runtime: { maxRetries: 0, runTimeoutMs: 10_000 },
};
const envelope = (method: string, params: unknown) => ({
  jsonrpc: "2.0",
  protocolVersion: "2.0",
  id: "request",
  method,
  params,
});
const task = (action: string, rest: object = {}) =>
  envelope("task", { action, sessionId: "bound", taskId: "job", ...rest });

async function fixture(
  context: TestContext,
  options: Omit<WorkerServerOptions, "send"> = { tasks: { definitions: [definition] } },
) {
  const dir = await mkdtemp(path.join(tmpdir(), "coremind-task-host-"));
  const hosts: ProtocolHost[] = [];
  context.onTestFinished(async () => {
    for (const host of hosts)
      expect(await host.shutdown()).toEqual({ closed: true, quiescent: true });
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()));
    expect(path.basename(dir)).toMatch(/^coremind-task-host-/u);
    await rm(dir, { recursive: true, force: true });
  });
  const open = async (
    settings = options,
    overrides: object = {},
    capabilities = ["durableTasks", "sessionBranches"],
  ) => {
    const host = new ProtocolHost({ ...settings, send: () => {} });
    hosts.push(host);
    const initialized = await host.handle({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
        config,
        configDir: dir,
        cwd: dir,
        sessionId: "bound",
        capabilities,
        ...overrides,
      },
    });
    expect(initialized).toHaveProperty("result");
    return { host, initialized };
  };
  return { dir, open };
}

describe("Worker持久任务与会话桥接", () => {
  it("重新打开时改变项目代码信任开关必须触发任务权限身份不匹配", async (context) => {
    const f = await fixture(context, {
      tasks: { definitions: [definition], runtime: { authorityVersion: "host-1" } },
    });
    const first = (await f.open()).host;
    await first.handle(task("start", { type: "demo", checkpoint: 0 }));
    await first.shutdown();
    const second = (await f.open(undefined, { trustProjectCode: true })).host;
    expect(await second.handle(task("resume"))).toMatchObject({
      error: { data: { details: { taskCode: "task_authority_mismatch", taskId: "job" } } },
    });
    expect(await second.handle(task("query"))).toMatchObject({
      result: { task: { checkpoint: 0, status: "ready" } },
    });
  });
  it("只由宿主注册定义；缺失能力、未知定义和越权会话保留错误身份", async (context) => {
    const f = await fixture(context);
    const missing = await f.open({});
    expect(missing.initialized).not.toMatchObject({
      result: { serverCapabilities: expect.arrayContaining(["durableTasks"]) },
    });
    expect(await missing.host.handle(task("start", { type: "demo", checkpoint: 0 }))).toMatchObject(
      {
        error: {
          data: {
            coremindCode: "protocol_capability_missing",
            details: { sessionId: "bound", taskId: "job" },
          },
        },
      },
    );
    const { host } = await f.open();
    expect(await host.handle(task("start", { type: "unknown", checkpoint: 0 }))).toMatchObject({
      error: {
        data: {
          coremindCode: "unclassified_error",
          details: {
            operation: "task",
            action: "start",
            taskId: "job",
            taskCode: "task_definition_unknown",
          },
        },
      },
    });
    expect(await host.handle(task("query", { sessionId: "other" }))).toMatchObject({
      error: {
        data: {
          coremindCode: "session_navigation_invalid",
          details: { sessionId: "other", taskId: "job" },
        },
      },
    });
    expect(
      await host.handle(task("start", { type: "demo", checkpoint: 0, source: "code" })),
    ).toMatchObject({
      error: { data: { coremindCode: "protocol_validation_failed" } },
    });
  });

  it("持久等待、显式wake、旧通知与重开结果完全复用TaskSession", async (context) => {
    const f = await fixture(context);
    const first = (await f.open()).host;
    expect(await first.handle(task("start", { type: "demo", checkpoint: 0 }))).toMatchObject({
      result: { task: { taskId: "job", status: "ready", checkpoint: 0 } },
    });
    const sleeping = await first.handle(task("resume"));
    expect(sleeping).toMatchObject({
      result: { task: { phase: "b", status: "sleeping", checkpoint: 1 } },
    });
    const state = (sleeping as { result: { task: { sleep: { sleepId: string } } } }).result.task;
    await first.shutdown();
    const second = (await f.open()).host;
    expect(
      await second.handle(envelope("task", { sessionId: "bound", action: "next_wake" })),
    ).toMatchObject({
      result: { deadline: { taskId: "job", sleepId: state.sleep.sleepId, remainingMs: 0 } },
    });
    const wake = task("wake", { wakeId: "wake", sleepId: state.sleep.sleepId });
    expect(await second.handle(wake)).toMatchObject({
      result: { wakeStatus: "accepted", task: { status: "ready" } },
    });
    expect(await second.handle(wake)).toMatchObject({ result: { wakeStatus: "duplicate" } });
    const completed = await second.handle(task("resume"));
    expect(completed).toMatchObject({ result: { task: { status: "completed", checkpoint: 2 } } });
    expect(await second.handle(task("resume"))).toEqual(completed);
  });

  it("活动阶段允许查询和按任务取消，拒绝第二执行及导航；关闭释放原writer", async (context) => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocking: TaskDefinition = {
      ...definition,
      type: "blocking",
      phases: {
        a: async ({ signal }) => {
          entered();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          return { phase: "a", checkpoint: 0 };
        },
      },
    };
    const f = await fixture(context, { tasks: { definitions: [blocking] } });
    const { host } = await f.open();
    await host.handle(task("start", { type: "blocking", checkpoint: 0 }));
    const running = host.handle(task("resume"));
    await started;
    expect(await host.handle(task("query"))).toHaveProperty("result");
    expect(await host.handle(task("resume"))).toMatchObject({
      error: { data: { coremindCode: "worker_busy" } },
    });
    expect(
      await host.handle(envelope("session", { action: "inspect", sessionId: "bound" })),
    ).toMatchObject({
      error: { data: { coremindCode: "worker_busy" } },
    });
    expect(
      await host.handle(envelope("run", { runId: "competing", input: "不得执行" })),
    ).toMatchObject({
      error: { data: { coremindCode: "worker_busy" } },
    });
    expect(await host.handle(task("cancel"))).toMatchObject({
      result: { task: { status: "cancelled" } },
    });
    expect(await running).toMatchObject({
      error: { data: { details: { taskId: "job", taskCode: "task_cancelled" } } },
    });
    await host.shutdown();
    const reopened = (await f.open()).host;
    expect(await reopened.handle(task("query"))).toMatchObject({
      result: { task: { status: "cancelled" } },
    });
  });

  it("会话分支持久化且RPC不能越过初始化绑定；旧客户端未协商能力时拒绝", async (context) => {
    const f = await fixture(context);
    const first = (await f.open()).host;
    const navigate = (action: string, extra = {}) =>
      envelope("session", { action, sessionId: "bound", ...extra });
    expect(
      await first.handle(navigate("create", { branchId: "alternate", at: null })),
    ).toHaveProperty("result");
    expect(await first.handle(navigate("select", { branchId: "alternate" }))).toMatchObject({
      result: { tree: { activeBranch: "alternate" } },
    });
    expect(await first.handle(navigate("inspect", { sessionId: "other" }))).toMatchObject({
      error: { data: { coremindCode: "session_navigation_invalid" } },
    });
    await first.shutdown();
    const reopened = (await f.open()).host;
    expect(await reopened.handle(navigate("inspect"))).toMatchObject({
      result: { tree: { activeBranch: "alternate" } },
    });
    const unnegotiated = (await f.open({}, {}, [])).host;
    expect(await unnegotiated.handle(navigate("inspect"))).toMatchObject({
      error: { data: { coremindCode: "protocol_capability_missing" } },
    });
  });

  it("可信任务注册不绕过工具审批，也不授权加载配置中的项目脚本", async (context) => {
    let executions = 0;
    const controlled: TaskDefinition = {
      ...definition,
      phases: {
        a: async (ctx) => {
          await ctx.runCalls(async ({ executeTool }) => {
            await executeTool("read", "probe", {});
            return null;
          });
          return { phase: "a", checkpoint: 1, done: true };
        },
      },
    };
    const f = await fixture(context, {
      tasks: {
        definitions: [controlled],
        runtime: {
          authorityVersion: "host-1",
          approveTool: async () => "deny",
          toolDefinitions: [
            {
              name: "probe",
              description: "受控读取",
              parameters: { type: "object", additionalProperties: false },
              effect: { operations: ["read"], reversible: true },
              execute: async () => {
                executions += 1;
                return { text: "不应执行" };
              },
            },
          ],
        },
      },
    });
    const { host } = await f.open();
    await host.handle(task("start", { type: "demo", checkpoint: 0 }));
    expect(await host.handle(task("resume"))).toHaveProperty("error");
    expect(executions).toBe(0);
    expect(await host.handle(task("query"))).toMatchObject({
      result: { task: { status: "paused", checkpoint: 0 } },
    });
    await host.shutdown();
    await writeFile(
      path.join(f.dir, "untrusted.mjs"),
      "import{writeFileSync}from'node:fs';writeFileSync(new URL('./marker',import.meta.url),'bad','utf8');export default {};\n",
      "utf8",
    );
    const second = await f.open(
      { tasks: { definitions: [controlled], runtime: { authorityVersion: "untrusted-1" } } },
      {
        sessionId: "untrusted",
        config: {
          ...config,
          tools: [{ path: "./untrusted.mjs", effect: { operations: ["read"], reversible: true } }],
        },
      },
    );
    await second.host.handle(
      task("start", { sessionId: "untrusted", type: "demo", checkpoint: 0 }),
    );
    expect(await second.host.handle(task("resume", { sessionId: "untrusted" }))).toHaveProperty(
      "error",
    );
    await expect(readFile(path.join(f.dir, "marker"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
