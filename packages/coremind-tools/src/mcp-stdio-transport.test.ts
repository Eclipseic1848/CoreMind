import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpStdioClient } from "./mcp-stdio-client.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/mcp-stdio-server.mjs");

it.skipIf(process.platform !== "win32")("原始 orphan 夹具在父退出后仍产生新心跳", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-orphan-calibration-"));
  const recordPath = path.join(directory, "records.jsonl");
  const records = async () =>
    (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const root = spawn(process.execPath, [fixture, recordPath, "orphan"], {
    cwd: directory,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  let spawnError: Error | undefined;
  root.on("error", (error) => {
    spawnError = error;
  });
  let childPid: number | undefined;
  try {
    await vi.waitFor(
      async () => {
        if (spawnError) throw spawnError;
        const current = await records();
        const started = current.find((record) => record.type === "started");
        expect(started?.pid).toBe(root.pid);
        expect(started?.childPid).toBeTypeOf("number");
        childPid = started.childPid;
        expect(current).toContainEqual({ type: "child-ready", pid: childPid });
        expect(
          current.some((record) => record.type === "heartbeat" && record.pid === childPid),
        ).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );
    root.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { value: "orphan 校准" } },
      })}\n`,
    );
    await vi.waitFor(
      () => {
        expect(root.exitCode).toBe(0);
        expect(alive(root.pid!)).toBe(false);
      },
      { timeout: 3_000, interval: 20 },
    );
    const heartbeatCount = (await records()).filter(
      (record) => record.type === "heartbeat" && record.pid === childPid,
    ).length;
    await vi.waitFor(
      async () => {
        expect(alive(childPid!)).toBe(true);
        expect(
          (await records()).filter(
            (record) => record.type === "heartbeat" && record.pid === childPid,
          ).length,
        ).toBeGreaterThanOrEqual(heartbeatCount + 2);
      },
      { timeout: 2_000, interval: 20 },
    );
  } finally {
    // 校准清理只回收本格自有 PID，不作为产品关闭通过的证据。
    try {
      if (root.pid !== undefined) cleanup(root.pid);
    } finally {
      try {
        childPid ??= (await records()).find((record) => record.type === "started")?.childPid;
        if (childPid !== undefined) cleanup(childPid);
        await vi.waitFor(
          () => {
            if (root.pid !== undefined) expect(alive(root.pid)).toBe(false);
            if (childPid !== undefined) expect(alive(childPid)).toBe(false);
          },
          { timeout: 3_000, interval: 20 },
        );
      } finally {
        root.stdin.destroy();
        const target = await realpath(directory);
        expect(path.dirname(target).toLowerCase()).toBe((await realpath(tmpdir())).toLowerCase());
        expect(path.basename(target)).toMatch(/^coremind-mcp-orphan-calibration-/u);
        await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }
  }
});

it.each(["normal", "orphan", "bad-init", "cancel", "close"])(
  "%s 生命周期关闭必须清理真实服务及其子进程",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-tree-"));
    const recordPath = path.join(directory, "records.jsonl");
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
    });
    const client = createMcpStdioClient({
      command: process.execPath,
      args: [fixture, recordPath, mode === "cancel" ? "hang" : mode],
      cwd: directory,
      env: {},
      runEnvironment: environment,
      artifactStore: new ArtifactStore({ cwd: directory }),
    });
    let pids: { pid: number; childPid: number } | undefined;
    const failures: unknown[] = [];
    try {
      expect(client.environmentSummary).toBeUndefined();
      expect(environment.isQuiescent()).toBe(true);
      if (mode === "bad-init")
        await expect(client.connect()).rejects.toMatchObject({ code: "mcp_protocol_error" });
      else await client.connect();
      pids = (await readFile(recordPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((record) => record.type === "started");
      expect(pids!.pid).toBeTypeOf("number");
      expect(pids!.childPid).toBeTypeOf("number");
      if (mode !== "bad-init")
        await vi.waitFor(async () => {
          const records = (await readFile(recordPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(records).toContainEqual({ type: "child-ready", pid: pids!.childPid });
          expect(
            records.filter((record) => record.type === "heartbeat" && record.pid === pids!.childPid)
              .length,
          ).toBeGreaterThan(0);
        });
      if (mode !== "bad-init") {
        expect(alive(pids!.pid)).toBe(true);
        expect(alive(pids!.childPid)).toBe(true);
        expect(environment.isQuiescent()).toBe(false);
        expect(client.environmentSummary).toMatchObject({
          isolation: "trusted_host",
          credentialIsolation: "none",
          networkEgress: "unrestricted",
        });
      }
      if (mode === "normal" || mode === "orphan" || mode === "cancel") {
        const tools = await client.listTools();
        const controller = new AbortController();
        const calling = client.callTool(tools[0]!, { value: "完成后退出" }, controller.signal);
        if (mode === "cancel") {
          await vi.waitFor(async () =>
            expect(await readFile(recordPath, "utf8")).toContain('"method":"tools/call"'),
          );
          controller.abort();
          await expect(calling).rejects.toBeDefined();
        } else await calling;
      }
      if (mode === "orphan") {
        await vi.waitFor(() => expect(alive(pids!.pid)).toBe(false));
      }
      await client.close();
      await vi.waitFor(() => {
        expect(alive(pids!.pid)).toBe(false);
        expect(alive(pids!.childPid)).toBe(false);
      });
      expect(environment.isQuiescent()).toBe(true);
      await client.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await client.close();
    } catch (cause) {
      failures.push(new Error("产品关闭失败", { cause }));
    }
    try {
      if (!pids) {
        pids = (await readFile(recordPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
          .find((record) => record.type === "started");
      }
      if (pids) {
        try {
          expect(alive(pids.pid)).toBe(false);
          expect(alive(pids.childPid)).toBe(false);
        } catch (cause) {
          failures.push(new Error("产品关闭后仍有自有进程", { cause }));
        }
        for (const pid of [pids.childPid, pids.pid]) cleanup(pid);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cause);
    }
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (cause) {
      failures.push(new Error(`本格临时目录清理失败：${directory}`, { cause }));
    }
    if (failures.length) throw new AggregateError(failures, "本地 MCP 生命周期主流程与清理证据");
  },
);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function cleanup(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
    throw new Error("夹具自有 PID 无效");
  if (!alive(pid)) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 失败清理仅避免红例污染宿主，不作为产品清理通过的证据。
    }
  }
}
