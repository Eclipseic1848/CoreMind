// 测试只使用固定假值，避免依赖工作区外的测试夹具而越过 Worker rootDir。
process.env.COREMIND_TEST_API_KEY = "test-only";
process.env.DEEPSEEK_API_KEY = "test-only";

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { WorkerServer } from "./server.js";
import { createStdioSender, runStdioWorker } from "./stdio.js";

describe("stdio 传输背压", () => {
  it("等待 drain 并在有界队列满时只丢弃 live event", () => {
    const writes: string[] = [];
    let blocked = true;
    const output = Object.assign(new EventEmitter(), {
      write(value: string) {
        writes.push(value);
        if (blocked) {
          blocked = false;
          return false;
        }
        return true;
      },
    }) as unknown as NodeJS.WritableStream;
    const send = createStdioSender(output, { maxQueuedMessages: 1 });
    const live = (sequence: number) => ({
      jsonrpc: "2.0",
      method: "event",
      params: { runId: "run-1", sequence },
    });

    send(live(1));
    send(live(2));
    send(live(3));
    send({ jsonrpc: "2.0", id: "response", result: { ok: true } });

    expect(writes).toHaveLength(1);
    output.emit("drain");
    expect(writes.map((line) => JSON.parse(line))).toEqual([
      live(1),
      live(2),
      { jsonrpc: "2.0", id: "response", result: { ok: true } },
    ]);
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
});
