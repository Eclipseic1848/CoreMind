import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { McpStdioTransport } from "./mcp-stdio-transport.js";

const boundary = vi.hoisted(() => ({ launch: vi.fn() }));

// 只控制原生 Job 边界；Transport 与活动结算使用生产实现。
vi.mock("./windows-mcp-job.js", () => ({ launchWindowsMcpJob: boundary.launch }));
vi.mock("./process-runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./process-runner.js")>()),
  probeProcessTreeTermination: async () => ({
    available: true,
    evidence: ["controlled-process-tree"],
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const eventTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const canary = "mcp-close-private-canary";

function controlledService(signal?: AbortSignal) {
  const subprocessFinished = deferred<void>();
  const rootFinished = deferred<void>();
  const jobFinished = deferred<void>();
  const nodeChildProcess = new EventEmitter();
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
  const finishRoot = () => {
    nodeChildProcess.emit("exit", 0, null);
    for (const stream of streams) stream.destroy();
    subprocessFinished.resolve();
    rootFinished.resolve();
  };
  const closeJob = vi.fn(() => {
    queueMicrotask(finishRoot);
    return jobFinished.promise;
  });
  const subprocess = Object.assign(subprocessFinished.promise, {
    pid: 42420,
    stdin: streams[0],
    stdout: streams[1],
    stderr: streams[2],
    nodeChildProcess,
    kill: vi.fn(),
  });
  boundary.launch.mockResolvedValue({
    process: subprocess,
    ready: Promise.resolve(),
    close: closeJob,
  });
  const environment = createFakeExecutionEnvironment({
    claimed: { networkEgress: "unrestricted" },
    observed: { networkEgress: "unrestricted" },
  });
  const transport = new McpStdioTransport({
    command: "controlled-mcp-service",
    args: [],
    cwd: process.cwd(),
    env: { MCP_CLOSE_SECRET: canary },
    signal,
    runEnvironment: environment,
    artifactStore: new ArtifactStore({ cwd: process.cwd() }),
  });
  return {
    transport,
    environment,
    rootFinished: rootFinished.promise,
    closeJob,
    kill: subprocess.kill,
    release(error?: Error) {
      if (error) jobFinished.reject(error);
      else jobFinished.resolve();
    },
  };
}

describe.skipIf(process.platform !== "win32")("Windows MCP 关闭必须等待整树回收确认", () => {
  beforeEach(() => {
    boundary.launch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("根和管道 finished 后，Job 未确认仍保持关闭 pending、活动未结算且不通知 onclose", async () => {
    const fixture = controlledService();
    const onclose = vi.fn();
    fixture.transport.onclose = onclose;
    await fixture.transport.start();
    let settled = false;
    const closing = fixture.transport.close();
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await fixture.rootFinished;
      await eventTurn();
      expect(settled).toBe(false);
      expect(fixture.environment.isQuiescent()).toBe(false);
      expect(onclose).not.toHaveBeenCalled();
      expect(fixture.transport.close()).toBe(closing);
      expect(fixture.closeJob).toHaveBeenCalledTimes(1);
      expect(fixture.kill).not.toHaveBeenCalled();
      fixture.release();
      await closing;
      expect(fixture.environment.isQuiescent()).toBe(true);
      expect(onclose).toHaveBeenCalledTimes(1);
      expect(fixture.transport.close()).toBe(closing);
      expect(fixture.closeJob).toHaveBeenCalledTimes(1);
    } finally {
      fixture.release();
      await closing.catch(() => {});
    }
  });

  it.each(["caller", "activity"] as const)("%s abort 进入同一关闭 owner", async (source) => {
    const controller = new AbortController();
    const fixture = controlledService(source === "caller" ? controller.signal : undefined);
    await fixture.transport.start();
    let termination: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      if (source === "caller") controller.abort();
      else termination = fixture.environment.terminate("取消本格活动");
      // 先观察取消自行启动关闭，防止显式 close 掩盖遗漏的 listener。
      await vi.waitFor(() => expect(fixture.closeJob).toHaveBeenCalledTimes(1));
      closing = fixture.transport.close();
      await fixture.rootFinished;
      await eventTurn();
      expect(fixture.environment.isQuiescent()).toBe(false);
      expect(fixture.kill).not.toHaveBeenCalled();
      fixture.release();
      await closing;
      await termination;
      expect(fixture.environment.isQuiescent()).toBe(true);
      expect(fixture.closeJob).toHaveBeenCalledTimes(1);
    } finally {
      closing ??= fixture.transport.close();
      await eventTurn();
      fixture.release();
      await closing.catch(() => {});
      await termination?.catch(() => {});
    }
  });

  it("Job 回收失败不假静止，错误不携带诊断中的秘密", async () => {
    const fixture = controlledService();
    await fixture.transport.start();
    const closing = fixture.transport.close();
    const result = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await fixture.rootFinished;
      fixture.release(new Error(canary));
      const error = await result;
      expect(error).toMatchObject({ code: "mcp_cleanup_failed" });
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(String(error)).not.toContain(canary);
      expect(fixture.environment.isQuiescent()).toBe(false);
      expect(fixture.transport.close()).toBe(closing);
    } finally {
      fixture.release();
      await closing.catch(() => {});
    }
  });

  it("根已结束但 Job 未确认，5 秒总期限失败且保持活动未结算", async () => {
    const fixture = controlledService();
    await fixture.transport.start();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const closing = fixture.transport.close();
    const result = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await fixture.rootFinished;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await result).toMatchObject({ code: "mcp_cleanup_failed" });
      expect(fixture.environment.isQuiescent()).toBe(false);
      expect(fixture.closeJob).toHaveBeenCalledTimes(1);
    } finally {
      fixture.release();
      await closing.catch(() => {});
    }
  });
});
