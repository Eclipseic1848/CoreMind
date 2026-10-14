import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import { createMcpStdioClient } from "./mcp-stdio-client.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/mcp-stdio-server.mjs");

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
      await rm(directory, { recursive: true, force: true });
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
