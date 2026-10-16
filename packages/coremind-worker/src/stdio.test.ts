// 测试只使用固定假值，避免依赖工作区外的测试夹具而越过 Worker rootDir。
process.env.COREMIND_TEST_API_KEY = "test-only";
process.env.DEEPSEEK_API_KEY = "test-only";

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { CheckpointManager, type CoreMindEvent, FileRunStore, RunStateJournal } from "coremind-ai";
import { createEventNotification } from "coremind-protocol";
import { describe, expect, it, vi } from "vitest";
import { WorkerServer } from "./server.js";
import { createStdioSender, runStdioWorker } from "./stdio.js";

class ControlledOutput extends EventEmitter {
  readonly writes: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  write(text: string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(text);
    this.callbacks.push(callback);
    return this.writes.length !== 1;
  }
  stream(): NodeJS.WritableStream {
    return this as unknown as NodeJS.WritableStream;
  }
  deliverFrom(start: number): void {
    for (let index = start; index < this.callbacks.length; index++) {
      this.callbacks[index]!();
      if (index === 0) this.emit("drain");
    }
  }
}
describe("stdio 传输背压", () => {
  it("队列条数包含在飞消息，仅 live event 可丢且仍保留关键响应顺序", async () => {
    const output = new ControlledOutput();
    const failed = vi.fn();
    const sender = createStdioSender(output.stream(), { onFailure: failed });
    const live = (sequence: number) => ({
      jsonrpc: "2.0",
      method: "event",
      params: { runId: "run-1", sequence },
    });
    try {
      for (let index = 1; index <= 1_024; index++) sender.send(live(index));
      sender.send(live(1_025));
      expect(output.writes).toHaveLength(1);
      expect(failed).not.toHaveBeenCalled();
      output.callbacks[0]!();
      output.emit("drain");
      sender.send({ jsonrpc: "2.0", id: "response", result: { ok: true } });
      output.deliverFrom(1);
      await sender.flush();
      const messages = output.writes.map((line) => JSON.parse(line));
      expect(messages.slice(0, -1)).toEqual(
        Array.from({ length: 1_024 }, (_, index) => live(index + 1)),
      );
      expect(messages.at(-1)).toMatchObject({ id: "response", result: { ok: true } });
      expect(failed).not.toHaveBeenCalled();
    } finally {
      await sender.close();
    }
  });

  it("审批通知在字节预算耗尽时明确失败而不静默丢弃", async () => {
    const output = new ControlledOutput();
    const failed = vi.fn();
    const text = createEventNotification({
      runId: "run-1",
      sequence: 1,
      timestamp: "2026-10-16T00:00:00Z",
      event: { type: "text_delta", agent: "main", delta: "正文" } satisfies CoreMindEvent,
    });
    const approval = createEventNotification({
      runId: "run-1",
      sequence: 2,
      timestamp: "2026-10-16T00:00:00Z",
      event: {
        type: "approval_required",
        approvalId: "approval-1",
        runId: "run-1",
        agent: "main",
        tool: "write",
        callId: "call-1",
        args: { path: "notes.txt", content: "正文" },
        risk: "high",
        effect: {
          operations: ["write"],
          paths: ["notes.txt"],
          urls: [],
          reversible: true,
          declared: true,
        },
      } satisfies CoreMindEvent,
    });
    const maxPendingBytes =
      Buffer.byteLength(`${JSON.stringify(text)}\n${JSON.stringify(approval)}\n`, "utf8") - 1;
    const sender = createStdioSender(output.stream(), { maxPendingBytes, onFailure: failed });
    try {
      sender.send(text);
      sender.send(approval);
      expect(sender.failure).toMatchObject({ code: "output_delivery_failed" });
      await expect(sender.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
      expect(failed).toHaveBeenCalledOnce();
      expect(output.writes).toHaveLength(1);
    } finally {
      output.deliverFrom(0);
      await sender.close();
    }
  });

  it("关键响应超预算明确失败一次，不继续编码后续响应", async () => {
    const output = new ControlledOutput();
    const failed = vi.fn();
    const sender = createStdioSender(output.stream(), { maxPendingBytes: 8, onFailure: failed });
    try {
      sender.send({ result: "private-large-body" });
      const later = { toJSON: vi.fn(() => ({ result: "late" })) };
      sender.send(later);
      await expect(sender.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
      expect(later.toJSON).not.toHaveBeenCalled();
      expect(failed).toHaveBeenCalledOnce();
      expect(String(sender.failure)).not.toContain("private-large-body");
      expect(output.writes).toEqual([]);
    } finally {
      await sender.close();
    }
  });

  it("EOF 等待已接收 RPC 的响应及最后输出回调", async () => {
    const input = new PassThrough();
    const output = new ControlledOutput();
    let answer!: () => void;
    const handle = vi.spyOn(WorkerServer.prototype, "handle").mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ jsonrpc: "2.0", id: "pending", result: { ok: true } });
        }),
    );
    const shutdown = vi
      .spyOn(WorkerServer.prototype, "shutdown")
      .mockResolvedValue({ closed: true, quiescent: true });
    const completion = runStdioWorker(input, output.stream());
    let completed = false;
    void completion.then(() => {
      completed = true;
    });
    try {
      input.write('{"id":"pending"}\n');
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
      input.end();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      answer();
      await vi.waitFor(() => expect(output.writes).toHaveLength(1));
      expect(completed).toBe(false);
      output.callbacks[0]!();
      await Promise.resolve();
      expect(completed).toBe(false);
      output.emit("drain");
      await completion;
      expect(JSON.parse(output.writes[0]!)).toMatchObject({ id: "pending", result: { ok: true } });
    } finally {
      handle.mockRestore();
      shutdown.mockRestore();
      input.destroy();
    }
  });

  it("普通输出背压不暂停 approve/cancel/tool_result 输入", async () => {
    const input = new PassThrough();
    const output = new ControlledOutput();
    const seen: string[] = [];
    const handle = vi.spyOn(WorkerServer.prototype, "handle").mockImplementation(async (value) => {
      const request = value as { id: string; method: string };
      seen.push(request.method);
      return { jsonrpc: "2.0", id: request.id, result: { accepted: true } };
    });
    const shutdown = vi
      .spyOn(WorkerServer.prototype, "shutdown")
      .mockResolvedValue({ closed: true, quiescent: true });
    const completion = runStdioWorker(input, output.stream());
    try {
      input.write('{"id":"run","method":"run"}\n');
      await vi.waitFor(() => expect(output.writes).toHaveLength(1));
      for (const method of ["approve", "cancel", "tool_result"])
        input.write(`${JSON.stringify({ id: method, method })}\n`);
      await vi.waitFor(() => expect(seen).toEqual(["run", "approve", "cancel", "tool_result"]));
      expect(output.writes).toHaveLength(1);
      output.deliverFrom(0);
      input.end();
      await completion;
      expect(output.writes.map((line) => JSON.parse(line).id)).toEqual(seen);
    } finally {
      handle.mockRestore();
      shutdown.mockRestore();
      input.destroy();
    }
  });

  it("断管只启动一次 shutdown，等待其完成后以类型化错误结束", async () => {
    const input = new PassThrough();
    const output = new ControlledOutput();
    let release!: () => void;
    const shutdown = vi.spyOn(WorkerServer.prototype, "shutdown").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ closed: true, quiescent: true });
        }),
    );
    const completion = runStdioWorker(input, output.stream());
    const rejected = expect(completion).rejects.toMatchObject({ code: "output_delivery_failed" });
    let completed = false;
    void completion.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    try {
      input.write("{\n");
      expect(output.writes).toHaveLength(1);
      output.emit("error", new Error("Bearer private-pipe-error"));
      output.emit("close");
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      release();
      await rejected;
      for (const event of ["drain", "error", "close"]) expect(output.listenerCount(event)).toBe(0);
    } finally {
      release?.();
      shutdown.mockRestore();
      input.destroy();
    }
  });

  it("未达到静止的 EOF 不能当成成功", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const shutdown = vi
      .spyOn(WorkerServer.prototype, "shutdown")
      .mockResolvedValue({ closed: true, quiescent: false });
    const completion = runStdioWorker(input, output);
    const rejected = expect(completion).rejects.toMatchObject({ code: "worker_closed" });
    try {
      input.end();
      await rejected;
    } finally {
      shutdown.mockRestore();
      input.destroy();
      output.destroy();
    }
  });

  it("无法编码的关键响应明确失败，关闭后不再编码", async () => {
    const output = new ControlledOutput();
    const failed = vi.fn();
    const sender = createStdioSender(output.stream(), { onFailure: failed });
    const circular: { self?: unknown } = {};
    circular.self = circular;
    sender.send(circular);
    await expect(sender.flush()).rejects.toMatchObject({ code: "output_delivery_failed" });
    await sender.close();
    const late = { toJSON: vi.fn(() => ({})) };
    sender.send(late);
    expect(late.toJSON).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledOnce();
  });

  it("EOF 已接收响应永不完成时按共享交付截止失败", async () => {
    vi.useFakeTimers();
    const input = new PassThrough();
    const output = new PassThrough();
    const handle = vi
      .spyOn(WorkerServer.prototype, "handle")
      .mockImplementation(() => new Promise(() => {}));
    const shutdown = vi
      .spyOn(WorkerServer.prototype, "shutdown")
      .mockResolvedValue({ closed: true, quiescent: true });
    const completion = runStdioWorker(input, output);
    const rejected = expect(completion).rejects.toMatchObject({ code: "output_delivery_failed" });
    try {
      input.write('{"id":"pending"}\n');
      expect(handle).toHaveBeenCalledOnce();
      input.end();
      await vi.advanceTimersByTimeAsync(10_000);
      vi.useRealTimers();
      await rejected;
      expect(shutdown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      handle.mockRestore();
      shutdown.mockRestore();
      input.destroy();
      output.destroy();
    }
  });

  it("EOF completion 必须等待 Worker shutdown 完成", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let releaseShutdown: (() => void) | undefined;
    const shutdown = vi.spyOn(WorkerServer.prototype, "shutdown").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseShutdown = () => resolve({ closed: true, quiescent: true });
        }),
    );

    try {
      const completion = runStdioWorker(input, output);
      expect(completion).toBeInstanceOf(Promise);
      input.end();
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      let completed = false;
      void completion.then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);

      releaseShutdown?.();
      await completion;
      expect(completed).toBe(true);
    } finally {
      shutdown.mockRestore();
      input.destroy();
      output.destroy();
    }
  });

  it("通过正式 dist/stdio.js 完成 v2 initialize、RunHandle 与 cancel", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-stdio-smoke-"));
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/stdio.js");
    const worker = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      worker.once("exit", (code, signal) => resolve({ code, signal })),
    );
    let exitedAfterEof = false;
    const lines = createInterface({ input: worker.stdout, crlfDelay: Number.POSITIVE_INFINITY });
    const pending = new Map<string, (message: Record<string, unknown>) => void>();
    lines.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      const resolve = pending.get(String(message.id));
      if (resolve) {
        pending.delete(String(message.id));
        resolve(message);
      }
    });
    const request = (message: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = String(message.id);
        pending.set(id, resolve);
        worker.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            pending.delete(id);
            reject(error);
          }
        });
      });

    try {
      const initialized = await request({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
          config: {
            schemaVersion: 2,
            name: "stdio-smoke",
            provider: {
              id: "probe",
              baseUrl: "http://127.0.0.1:9/v1",
              model: "probe-model",
              apiKeyEnv: "COREMIND_TEST_API_KEY",
            },
            agents: { main: {} },
          },
          configDir: directory,
          cwd: directory,
        },
      });
      const started = await request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "run",
        method: "run",
        params: { runId: "stdio-smoke-run", input: "smoke" },
      });
      const cancelled = await request({
        jsonrpc: "2.0",
        protocolVersion: "2.0",
        id: "close",
        method: "control",
        params: {
          schemaVersion: 1,
          controlId: "cancel-smoke",
          runId: "stdio-smoke-run",
          type: "cancel",
        },
      });

      expect(initialized).toMatchObject({ result: { selectedProtocol: "2.0" } });
      expect(started).toMatchObject({ result: { runId: "stdio-smoke-run" } });
      expect(cancelled).toMatchObject({
        result: { controlId: "cancel-smoke", status: "applied" },
      });
      worker.stdin.end();
      await vi.waitFor(() => expect(worker.exitCode).toBe(0), { timeout: 10_000 });
      await expect(exited).resolves.toEqual({ code: 0, signal: null });
      exitedAfterEof = true;
    } finally {
      if (!worker.stdin.destroyed) worker.stdin.end();
      if (!exitedAfterEof && worker.exitCode === null && worker.signalCode === null) worker.kill();
      await exited;
      lines.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("硬输出失败仍等待已接受 handle 收尾再 reject", async () => {
    const input = new PassThrough();
    const output = new ControlledOutput();
    let releaseHandle!: () => void;
    const handle = vi.spyOn(WorkerServer.prototype, "handle").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHandle = () => resolve({ jsonrpc: "2.0", id: "held", result: { ok: true } });
        }),
    );
    const shutdown = vi
      .spyOn(WorkerServer.prototype, "shutdown")
      .mockResolvedValue({ closed: true, quiescent: true });
    const completion = runStdioWorker(input, output.stream());
    let settled = false;
    void completion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejected = expect(completion).rejects.toMatchObject({ code: "output_delivery_failed" });
    try {
      input.write('{"id":"held"}\n');
      await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
      input.write("{\n");
      expect(output.writes).toHaveLength(1);
      output.emit("error", new Error("test-only broken pipe"));
      await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseHandle();
      await rejected;
      expect(output.writes).toHaveLength(1);
    } finally {
      releaseHandle?.();
      await completion.catch(() => undefined);
      await rejected;
      output.callbacks[0]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      handle.mockRestore();
      shutdown.mockRestore();
      input.destroy();
    }
  });

  it("真实 v1 restore 在断管后完成磁盘恢复才结束 stdio", async (context) => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-restore-output-"));
    const target = path.join(directory, "notes.txt");
    let child: import("node:child_process").ChildProcess | undefined;
    let closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let didClose = false;
    let stopping = false;
    let body: Promise<void> | undefined;
    let lines: ReturnType<typeof createInterface> | undefined;
    const observations: Array<Record<string, unknown>> = [];
    const waiting = new Map<
      string,
      { resolve: (message: Record<string, unknown>) => void; reject: (error: Error) => void }
    >();
    let failure: Error | undefined;
    let stderr = "";
    const fail = (error: Error) => {
      failure ??= error;
      for (const entry of waiting.values()) entry.reject(failure);
      waiting.clear();
    };
    const publish = (message: Record<string, unknown>) => {
      observations.push(message);
      waiting.get(String(message.event))?.resolve(message);
    };
    const bounded = async <T>(operation: Promise<T>, ms: number): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_yes, no) => {
            timer = setTimeout(() => no(new Error("restore 探针阶段超时")), ms);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    // 先登记所有权；超时也先放行/收拢自有进程和测试体，再允许清目录。
    context.onTestFinished(async () => {
      stopping = true;
      if (child?.connected) {
        try {
          child.send({ type: "release" }, () => {});
        } catch {}
      }
      child?.stdin?.end();
      if (closed && !didClose) {
        try {
          await bounded(closed, 2_000);
        } catch {
          if (!didClose) child!.kill("SIGKILL");
          await bounded(closed, 2_000);
        }
      }
      await bounded(body?.catch(() => undefined) ?? Promise.resolve(), 2_000);
      lines?.close();
      const resolved = path.resolve(directory);
      if (
        path.dirname(resolved) !== path.resolve(tmpdir()) ||
        !path.basename(resolved).startsWith("coremind-restore-output-")
      ) {
        throw new Error("拒绝清理无归属的 restore 探针目录");
      }
      rmSync(resolved, { recursive: true, force: true });
    });
    const checkOwner = () => {
      if (stopping) throw new Error("restore 探针已收尾");
    };
    body = (async () => {
      writeFileSync(target, "修改前", "utf8");
      const manager = new CheckpointManager({
        cwd: directory,
        rootDir: path.join(directory, ".coremind", "checkpoints"),
        runId: "restore-output",
      });
      const checkpoint = await manager.capture("edit", { path: "notes.txt" });
      checkOwner();
      expect(checkpoint).toBeDefined();
      writeFileSync(target, "修改后", "utf8");
      await manager.markApplied(checkpoint!.checkpointId);
      checkOwner();
      const store = new FileRunStore(path.join(directory, ".coremind", "runs"));
      const journal = new RunStateJournal("restore-output", store);
      await journal.start({ configName: "restore-output" });
      checkOwner();
      journal.checkpoint(checkpoint);
      journal.finish({ outcome: { status: "succeeded", finishReason: "completed" } });
      await journal.flush();
      checkOwner();
      const factsBefore = readFileSync(store.pathFor!("restore-output"), "utf8");
      const source = path.dirname(fileURLToPath(import.meta.url));
      const env = Object.fromEntries(
        ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP", "COMSPEC"].flatMap((name) =>
          process.env[name] ? [[name, process.env[name]!]] : [],
        ),
      );
      child = spawn(
        process.execPath,
        [
          path.join(source, "fixtures/stdio-restore-output.mjs"),
          path.resolve(source, "../dist/stdio.js"),
          path.resolve(source, "../../coremind/dist/index.js"),
          checkpoint!.checkpointId,
        ],
        {
          cwd: directory,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: { ...env, COREMIND_TEST_API_KEY: "test-only", DEEPSEEK_API_KEY: "test-only" },
        },
      );
      closed = new Promise((resolve) =>
        child!.once("close", (code, signal) => {
          didClose = true;
          fail(new Error(`restore 子进程已关闭：${code}/${signal} ${stderr}`));
          resolve({ code, signal });
        }),
      );
      child.on("error", fail);
      child.stdin!.on("error", fail);
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
        if (stderr.length < 16_384) stderr += chunk;
      });
      child.on("message", (message) => {
        if (message && typeof message === "object") publish(message as Record<string, unknown>);
      });
      lines = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
      lines.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          if (response.id === "init") publish({ event: "initialized", response });
        } catch {
          fail(new Error("restore 子进程产生非法 JSONL"));
        }
      });
      const deadline = performance.now() + 5_000;
      const step = async <T>(operation: Promise<T>) => {
        const value = await bounded(operation, Math.max(1, deadline - performance.now()));
        checkOwner();
        return value;
      };
      const wait = async (event: string) => {
        checkOwner();
        const existing = observations.find((entry) => entry.event === event);
        if (existing) return existing;
        if (failure) throw failure;
        try {
          return await step(
            new Promise<Record<string, unknown>>((resolve, reject) =>
              waiting.set(event, { resolve, reject }),
            ),
          );
        } finally {
          waiting.delete(event);
        }
      };
      await wait("ready");
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "1.0", config: { schemaVersion: 2, name: "restore-output", agents: { main: {} } }, configDir: directory, cwd: directory } })}\n`,
      );
      expect((await wait("initialized")).response).toMatchObject({
        id: "init",
        result: { protocolVersion: "1.0" },
      });
      child.stdin!.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "restore", method: "checkpoint_restore", params: { runId: "restore-output", checkpointId: checkpoint!.checkpointId, confirm: true } })}\n`,
      );
      await wait("restore_entered");
      expect(readFileSync(target, "utf8")).toBe("修改后");
      const outputClosed = new Promise<void>((resolve) => child!.stdout!.once("close", resolve));
      child.stdout!.destroy();
      await step(outputClosed);
      child.stdin!.write("{\n");
      expect(await wait("shutdown_returned")).toMatchObject({ quiescent: true });
      child.send({ type: "ping" }, (error) => {
        if (error) fail(error);
      });
      await wait("pong");
      expect(observations.filter((entry) => String(entry.event).startsWith("completion_"))).toEqual(
        [],
      );
      expect(readFileSync(target, "utf8")).toBe("修改后");
      child.send({ type: "release" }, (error) => {
        if (error) fail(error);
      });
      expect(await wait("completion_failed")).toMatchObject({ code: "output_delivery_failed" });
      expect(await step(closed)).toEqual({ code: 1, signal: null });
      expect(readFileSync(target, "utf8")).toBe("修改前");
      expect(readFileSync(store.pathFor!("restore-output"), "utf8")).toBe(factsBefore);
      expect(stderr).toContain("output_delivery_failed");
      expect(stderr).not.toMatch(/Unhandled 'error' event|ERR_UNHANDLED_ERROR/u);
      expect(observations.filter((entry) => entry.event === "shutdown_returned")).toHaveLength(1);
    })();
    await body;
  }, 15_000);
});
