import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { launchWindowsMcpJob, type WindowsMcpJob } from "./windows-mcp-job.js";

const fixture = path.resolve(process.cwd(), "test/fixtures/mcp-stdio-server.mjs");
type Mode = "normal" | "orphan" | "pre-abort" | "missing" | "dead-middle" | "forward-cwd";
type RecordEntry = { type: string; pid?: number; childPid?: number };

interface JobContext {
  job: WindowsMcpJob;
  controller: AbortController;
  recordPath: string;
}

describe.skipIf(process.platform !== "win32")("Windows MCP 原生 Job 所有权", () => {
  it.each(["close", "natural", "abort", "forward-cwd"] as const)(
    "%s 后真实树清空且重复关闭成功",
    async (mode) => {
      await withJob(
        mode === "natural" ? "orphan" : mode === "forward-cwd" ? "forward-cwd" : "normal",
        async ({ job, controller, recordPath }) => {
          await job.ready;
          const owned = await vi.waitFor(
            async () => {
              const current = await records(recordPath);
              const started = current.find((record) => record.type === "started");
              if (typeof started?.pid !== "number" || typeof started.childPid !== "number")
                throw new Error("真实服务尚未记录自有 PID");
              expect(
                current.some(
                  (record) => record.type === "heartbeat" && record.pid === started.childPid,
                ),
              ).toBe(true);
              expect(alive(started.pid)).toBe(true);
              expect(alive(started.childPid)).toBe(true);
              return { pid: started.pid, childPid: started.childPid };
            },
            { timeout: 3_000, interval: 20 },
          );
          if (mode === "natural") {
            job.process.stdin!.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "echo", arguments: { value: "自然退出后仍由 Job 回收" } },
              })}\n`,
            );
            await vi.waitFor(() => expect(alive(owned.pid)).toBe(false));
          }
          if (mode === "abort") controller.abort();
          await expect(Promise.all([job.close(), job.close()])).resolves.toEqual([
            undefined,
            undefined,
          ]);
          expect(alive(owned.pid)).toBe(false);
          expect(alive(owned.childPid)).toBe(false);
          expect((await job.process).exitCode).toBe(0);
        },
      );
    },
  );

  it.each(["pre-abort", "missing"] as const)("%s 不执行服务且仍完成真实回收", async (mode) => {
    await withJob(mode, async ({ job, recordPath }) => {
      await expect(job.ready).rejects.toBeDefined();
      await expect(job.close()).resolves.toBeUndefined();
      expect(existsSync(recordPath)).toBe(false);
      expect((await job.process).exitCode).toBe(0);
    });
  });

  it("中间祖先已退出的持续孙进程仍归属 Job", async () => {
    await withJob("dead-middle", async ({ job, recordPath }) => {
      await job.ready;
      const leafPid = await vi.waitFor(
        async () => {
          const current = await records(recordPath);
          const middle = current.find((record) => record.type === "middle");
          const leaf = current.find((record) => record.type === "leaf");
          if (typeof middle?.pid !== "number" || typeof leaf?.pid !== "number")
            throw new Error("真实后代尚未记录自有 PID");
          expect(alive(middle.pid)).toBe(false);
          expect(alive(leaf.pid)).toBe(true);
          expect(current.some((record) => record.type === "leaf-heartbeat")).toBe(true);
          return leaf.pid;
        },
        { timeout: 3_000, interval: 20 },
      );
      await expect(job.close()).resolves.toBeUndefined();
      expect(alive(leafPid)).toBe(false);
      expect((await job.process).exitCode).toBe(0);
    });
  });

  it("helper 异常退出未确认 active0 时关闭失败且原生 Job 仍回收服务", async () => {
    await withJob("normal", async ({ job, recordPath }) => {
      await job.ready;
      const owned = await vi.waitFor(
        async () => {
          const started = (await records(recordPath)).find((record) => record.type === "started");
          if (typeof started?.pid !== "number" || typeof started.childPid !== "number")
            throw new Error("真实服务尚未记录自有 PID");
          expect(alive(started.pid)).toBe(true);
          expect(alive(started.childPid)).toBe(true);
          return { pid: started.pid, childPid: started.childPid };
        },
        { timeout: 3_000, interval: 20 },
      );
      expect(job.process.nodeChildProcess.kill("SIGKILL")).toBe(true);
      await expect(job.close()).rejects.toMatchObject({ code: "mcp_cleanup_failed" });
      await vi.waitFor(() => {
        expect(alive(owned.pid)).toBe(false);
        expect(alive(owned.childPid)).toBe(false);
      });
    });
  });

  it("cmd/bat/shebang 保持中文路径、原始参数和隔离环境", async () => {
    const prefix = "coremind-windows-mcp-command-";
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    const cwd = path.join(directory, "中文 空格 & 目录");
    const previous = process.env.COREMIND_JOB_HOST_CANARY;
    const jobs: WindowsMcpJob[] = [];
    const recordPaths: string[] = [];
    const ownedPids = new Set<number>();
    const controller = new AbortController();
    const failures: unknown[] = [];
    process.env.COREMIND_JOB_HOST_CANARY = "host-only-canary";
    try {
      await mkdir(cwd);
      const probe = [
        "#!/usr/bin/env node",
        "const fs=require('node:fs');",
        "fs.writeFileSync(process.argv[2],JSON.stringify({pid:process.pid,argv:process.argv.slice(3),cwd:fs.realpathSync.native(process.cwd()),allowed:process.env.COREMIND_JOB_ALLOWED_CANARY,host:process.env.COREMIND_JOB_HOST_CANARY??null,ownerPipe:process.env.COREMIND_MCP_OWNER_PIPE??null,servicePipe:process.env.COREMIND_MCP_SERVICE_PIPE??null}),'utf8');",
        "setInterval(()=>{},1000);",
      ].join("\n");
      await writeFile(path.join(cwd, "probe.cjs"), probe, "utf8");
      for (const extension of ["cmd", "bat"])
        await writeFile(
          path.join(cwd, `入口 空格.${extension}`),
          '@echo off\r\nnode "%~dp0probe.cjs" %*\r\n',
          "utf8",
        );
      const argv = ["中文 空格", "", '引号"值', "&|<>^%!", "plain"];
      for (const entry of ["入口 空格.cmd", "入口 空格.bat", "probe.cjs"]) {
        const recordPath = path.join(cwd, `${entry}.json`);
        recordPaths.push(recordPath);
        const job = await launchWindowsMcpJob(
          {
            command: path.join(cwd, entry),
            args: [recordPath, ...argv],
            cwd,
            env: {
              PATH: path.dirname(process.execPath),
              PATHEXT: ".COM;.EXE;.BAT;.CMD",
              COREMIND_JOB_ALLOWED_CANARY: "显式 值 &%!",
            },
          },
          controller.signal,
        );
        jobs.push(job);
        if (job.process.pid !== undefined) ownedPids.add(job.process.pid);
        job.process.stdout?.resume();
        job.process.stderr?.resume();
        await job.ready;
        const actual = await vi.waitFor(
          async () => JSON.parse(await readFile(recordPath, "utf8")),
          { timeout: 3_000, interval: 20 },
        );
        ownedPids.add(actual.pid);
        expect(actual, entry).toEqual({
          pid: expect.any(Number),
          argv,
          cwd: await realpath(cwd),
          allowed: "显式 值 &%!",
          host: null,
          ownerPipe: null,
          servicePipe: null,
        });
        await expect(job.close(), entry).resolves.toBeUndefined();
        expect(alive(actual.pid), entry).toBe(false);
        expect((await job.process).exitCode, entry).toBe(0);
      }
    } catch (error) {
      failures.push(error);
    } finally {
      if (previous === undefined) delete process.env.COREMIND_JOB_HOST_CANARY;
      else process.env.COREMIND_JOB_HOST_CANARY = previous;
      controller.abort();
      for (const job of jobs) {
        try {
          await job.close();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        for (const recordPath of recordPaths)
          if (existsSync(recordPath))
            ownedPids.add(JSON.parse(await readFile(recordPath, "utf8")).pid);
      } catch (error) {
        failures.push(error);
      }
      for (const pid of ownedPids) {
        try {
          cleanup(pid);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await vi.waitFor(() => {
          for (const pid of ownedPids) expect(alive(pid)).toBe(false);
        });
        await Promise.all(jobs.map((job) => job.process));
      } catch (error) {
        failures.push(error);
      }
      try {
        const target = await realpath(directory);
        const parent = await realpath(tmpdir());
        if (
          !path.isAbsolute(target) ||
          path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
          !path.basename(target).startsWith(prefix)
        )
          failures.push(new Error("临时目录越出本格自有范围"));
        else await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Windows MCP 命令兼容与自有资源清理");
  });
});

async function withJob(mode: Mode, check: (context: JobContext) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "coremind-windows-mcp-job-"));
  const recordPath = path.join(directory, "records.jsonl");
  const controller = new AbortController();
  if (mode === "pre-abort") controller.abort();
  let job: WindowsMcpJob | undefined;
  const failures: unknown[] = [];
  try {
    job = await launchWindowsMcpJob(
      {
        command:
          mode === "missing" ? path.join(directory, "missing-service.exe") : process.execPath,
        args:
          mode === "dead-middle"
            ? ["-e", deadMiddleScript(recordPath)]
            : [fixture, recordPath, mode === "orphan" ? "orphan" : "normal"],
        cwd: mode === "forward-cwd" ? directory.replaceAll("\\", "/") : directory,
        env: {},
      },
      controller.signal,
    );
    job.process.stdout?.resume();
    job.process.stderr?.resume();
    await check({ job, controller, recordPath });
  } catch (error) {
    failures.push(error);
  } finally {
    // 产品关闭断言在前；以下自有 PID 兜底清理不作为产品成功证据。
    controller.abort();
    await job?.close().catch(() => undefined);
    try {
      const pids = new Set(
        (await records(recordPath)).flatMap((record) =>
          [record.childPid, record.pid].filter((pid): pid is number => typeof pid === "number"),
        ),
      );
      for (const pid of pids) cleanup(pid);
      await vi.waitFor(() => {
        for (const pid of pids) expect(alive(pid)).toBe(false);
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      if (job?.process.pid !== undefined) cleanup(job.process.pid);
      await job?.process;
    } catch (error) {
      failures.push(error);
    }
    try {
      const target = await realpath(directory);
      const parent = await realpath(tmpdir());
      if (
        path.dirname(target).toLowerCase() !== parent.toLowerCase() ||
        !path.basename(target).startsWith("coremind-windows-mcp-job-")
      )
        failures.push(new Error("临时目录越出本格自有范围"));
      else await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Windows MCP Job 主流程与自有资源清理");
}

async function records(recordPath: string): Promise<RecordEntry[]> {
  try {
    const text = (await readFile(recordPath, "utf8")).trim();
    return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function deadMiddleScript(recordPath: string): string {
  const record =
    "const { appendFileSync } = require('node:fs');" +
    "const record = value => appendFileSync(" +
    JSON.stringify(recordPath) +
    ", JSON.stringify(value) + '\\n', 'utf8');";
  const leaf =
    record +
    "record({type:'leaf',pid:process.pid});" +
    "setInterval(() => record({type:'leaf-heartbeat',pid:process.pid}),50);";
  const middle =
    record +
    "const {spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e'," +
    JSON.stringify(leaf) +
    "],{stdio:'ignore',detached:true,windowsHide:true});" +
    "record({type:'middle',pid:process.pid});process.exit(0);";
  return (
    record +
    "const {spawn}=require('node:child_process');record({type:'root',pid:process.pid});" +
    "spawn(process.execPath,['-e'," +
    JSON.stringify(middle) +
    "],{stdio:'ignore',detached:true,windowsHide:true});setInterval(()=>{},1000);"
  );
}

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
  if (alive(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
}
