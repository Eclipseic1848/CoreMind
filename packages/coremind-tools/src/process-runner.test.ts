import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFakeExecutionEnvironment } from "./execution-environment.js";
import {
  createSupervisedProcessRunner,
  ProcessRunner,
  ProcessRunnerError,
  probeProcessTreeTermination,
} from "./process-runner.js";

describe("ProcessRunner", () => {
  it("以参数数组执行进程并分别保留标准输出和标准错误", async () => {
    const streamed: string[] = [];
    const result = await new ProcessRunner().run({
      command: process.execPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"],
      onData: (chunk) => streamed.push(chunk.toString("utf8")),
    });

    expect(result).toMatchObject({ exitCode: 7, stdout: "out", stderr: "err", failed: true });
    expect(streamed.join("")).toContain("out");
    expect(streamed.join("")).toContain("err");
  });

  it("显式环境变量不会与宿主环境重新合并", async () => {
    const name = "COREMIND_PROCESS_RUNNER_SECRET";
    const previous = process.env[name];
    process.env[name] = "host-secret";
    try {
      const result = await new ProcessRunner().run({
        command: process.execPath,
        args: ["-e", `process.stdout.write(process.env.${name} ?? '')`],
        env: {},
      });
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("超时后返回稳定错误码", async () => {
    await expect(
      new ProcessRunner().run({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "process_timeout" });
  });

  it("超时会终止完整进程树，不遗留孙进程", async () => {
    const script = path.resolve(process.cwd(), "scripts", "process-tree-probe.mjs");
    let output = "";
    let childPid: number | undefined;
    try {
      await expect(
        new ProcessRunner().run({
          command: process.execPath,
          args: [script],
          timeoutMs: 200,
          onStdout: (chunk) => {
            output += chunk.toString("utf8");
            const match = output.match(/CHILD_PID:(\d+)/);
            if (match) childPid = Number(match[1]);
          },
        }),
      ).rejects.toMatchObject({ code: "process_timeout" });
      expect(childPid).toBeTypeOf("number");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isProcessAlive(childPid!)).toBe(false);
    } finally {
      if (childPid && isProcessAlive(childPid)) terminateProbeProcess(childPid);
    }
  });

  it("平台终止 probe 以真实子进程验证进程树能力", async () => {
    await expect(probeProcessTreeTermination()).resolves.toMatchObject({
      available: true,
      evidence: [expect.stringContaining(`process-tree:${process.platform}:verified`)],
    });
  });

  it("平台终止 probe 等待已取消后代完成退出", async () => {
    const originalKill = process.kill.bind(process);
    let aliveChecks = 0;
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0 && aliveChecks++ < 2) return true;
      return originalKill(pid, signal);
    });
    try {
      await expect(probeProcessTreeTermination()).resolves.toMatchObject({
        available: true,
        evidence: [expect.stringContaining(`process-tree:${process.platform}:verified`)],
      });
    } finally {
      killSpy.mockRestore();
    }
  });

  it("调用方取消后返回稳定错误码", async () => {
    const controller = new AbortController();
    const running = new ProcessRunner().run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      signal: controller.signal,
    });
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "process_aborted" });
  });

  it("执行环境终止会取消真实进程并在进程退出后恢复 Quiescent", async () => {
    const environment = createFakeExecutionEnvironment({
      claimed: { networkEgress: "unrestricted" },
      observed: { networkEgress: "unrestricted" },
      terminationTimeoutMs: 2_000,
    });
    const script = path.resolve(process.cwd(), "scripts", "process-tree-probe.mjs");
    let output = "";
    let childPid: number | undefined;
    try {
      const running = createSupervisedProcessRunner(environment).run({
        command: process.execPath,
        args: [script],
        onStdout: (chunk) => {
          output += chunk.toString("utf8");
          const match = output.match(/CHILD_PID:(\d+)/);
          if (match) childPid = Number(match[1]);
        },
      });
      await waitUntil(() => !environment.isQuiescent() && childPid !== undefined);

      const terminating = environment.terminate("测试取消");
      await expect(running).rejects.toMatchObject({ code: "process_aborted" });
      await expect(terminating).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(environment.isQuiescent()).toBe(true);
      expect(isProcessAlive(childPid!)).toBe(false);
    } finally {
      if (childPid && isProcessAlive(childPid)) terminateProbeProcess(childPid);
    }
  });

  it("输出超过上限时失败关闭", async () => {
    await expect(
      new ProcessRunner().run({
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(4096))"],
        maxOutputBytes: 128,
      }),
    ).rejects.toMatchObject({ code: "process_output_limit" });
  });

  it("进程参数导致无法启动时返回结构化错误", async () => {
    const failure = await new ProcessRunner()
      .run({ command: "invalid\0command" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProcessRunnerError);
    expect(failure).toMatchObject({ code: "process_spawn_failed" });
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("等待条件超时");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminateProbeProcess(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 测试创建的进程可能已在检查后自行退出。
  }
}
