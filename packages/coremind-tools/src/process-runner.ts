import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { execa } from "execa";

interface ProcessActivitySupervisor {
  beginActivity(input: { id: string; kind: "process" }): {
    readonly signal: AbortSignal;
    settle(): void;
  };
}

export type ProcessRunnerErrorCode =
  | "process_timeout"
  | "process_aborted"
  | "process_output_limit"
  | "process_spawn_failed";

export interface ProcessRunRequest {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onData?: (chunk: Buffer) => void;
  onStdout?: (chunk: Buffer) => void;
  onStderr?: (chunk: Buffer) => void;
}

export interface ProcessRunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  failed: boolean;
}

/** 统一暴露超时、取消、输出上限和启动失败，不把依赖库错误形状泄漏给调用方。 */
export class ProcessRunnerError extends Error {
  constructor(
    readonly code: ProcessRunnerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProcessRunnerError";
  }
}

/** 使用无 shell 的参数数组执行进程；需要 shell 语义时由上层显式选择解释器。 */
export class ProcessRunner {
  async run(request: ProcessRunRequest): Promise<ProcessRunResult> {
    if (request.signal?.aborted) {
      throw new ProcessRunnerError("process_aborted", "进程执行已取消");
    }
    const maxOutputBytes = request.maxOutputBytes ?? 10 * 1024 * 1024;
    if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
      throw new ProcessRunnerError("process_spawn_failed", "maxOutputBytes 必须是正整数");
    }

    let activity: ReturnType<ProcessActivitySupervisor["beginActivity"]> | undefined;
    let executionSignal = request.signal;
    try {
      activity = activitySupervisors.get(this)?.beginActivity({
        id: `process:${randomUUID()}`,
        kind: "process",
      });
      executionSignal = activity
        ? request.signal
          ? AbortSignal.any([request.signal, activity.signal])
          : activity.signal
        : request.signal;
      const subprocess = execa(request.command, [...(request.args ?? [])], {
        cwd: request.cwd,
        env: normalizeEnvironment(request.env),
        extendEnv: request.env === undefined,
        input: request.input,
        stdin: request.input === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
        encoding: "buffer",
        stripFinalNewline: false,
        reject: false,
        timeout: request.timeoutMs,
        cancelSignal: executionSignal,
        killDescendants: true,
        forceKillAfterDelay: 1_000,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
      });
      subprocess.stdout?.on("data", (chunk: Buffer) => {
        request.onStdout?.(chunk);
        request.onData?.(chunk);
      });
      subprocess.stderr?.on("data", (chunk: Buffer) => {
        request.onStderr?.(chunk);
        request.onData?.(chunk);
      });

      const result = await subprocess;
      if (result.timedOut) {
        throw new ProcessRunnerError(
          "process_timeout",
          `进程执行超过 ${request.timeoutMs ?? 0} 毫秒`,
        );
      }
      if (result.isCanceled || executionSignal?.aborted) {
        throw new ProcessRunnerError("process_aborted", "进程执行已取消");
      }
      if (result.isMaxBuffer) {
        throw new ProcessRunnerError(
          "process_output_limit",
          `进程输出超过 ${maxOutputBytes} 字节上限`,
        );
      }
      if (result.failed && result.exitCode === undefined) {
        throw new ProcessRunnerError(
          "process_spawn_failed",
          result.shortMessage ?? `无法启动命令：${request.command}`,
        );
      }
      return {
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode ?? null,
        stdout: Buffer.from(result.stdout ?? []).toString("utf8"),
        stderr: Buffer.from(result.stderr ?? []).toString("utf8"),
        durationMs: result.durationMs,
        failed: result.failed,
      };
    } catch (error) {
      if (error instanceof ProcessRunnerError) throw error;
      throw new ProcessRunnerError(
        executionSignal?.aborted ? "process_aborted" : "process_spawn_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    } finally {
      activity?.settle();
    }
  }
}

const activitySupervisors = new WeakMap<ProcessRunner, ProcessActivitySupervisor>();

/** 包内工厂：绑定执行环境的生命周期监督，不扩张 ProcessRunner 公共构造契约。 */
export function createSupervisedProcessRunner(
  activitySupervisor: ProcessActivitySupervisor | undefined,
): ProcessRunner {
  const runner = new ProcessRunner();
  if (activitySupervisor) activitySupervisors.set(runner, activitySupervisor);
  return runner;
}

export interface ProcessTreeProbeResult {
  available: boolean;
  evidence: readonly string[];
}

/** 用真实父子进程验证取消能否收敛完整进程树；结果供平台环境 Adapter 缓存。 */
export async function probeProcessTreeTermination(): Promise<ProcessTreeProbeResult> {
  const controller = new AbortController();
  let output = "";
  let childPid: number | undefined;
  const script = [
    "const { spawn } = require('node:child_process')",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
    "process.stdout.write('CHILD_PID:' + child.pid + '\\n')",
    "setInterval(() => {}, 1000)",
  ].join(";");
  const running = new ProcessRunner()
    .run({
      command: process.execPath,
      args: ["-e", script],
      signal: controller.signal,
      onStdout: (chunk) => {
        output += chunk.toString("utf8");
        const match = output.match(/CHILD_PID:(\d+)/);
        if (match) childPid = Number(match[1]);
      },
    })
    .catch((error: unknown) => error);

  try {
    const deadline = performance.now() + 2_000;
    while (childPid === undefined && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    if (childPid === undefined) {
      controller.abort();
      await running;
      return { available: false, evidence: [`process-tree:${process.platform}:no-child-pid`] };
    }
    controller.abort();
    const outcome = await running;
    if (!(outcome instanceof ProcessRunnerError) || outcome.code !== "process_aborted") {
      return {
        available: false,
        evidence: [`process-tree:${process.platform}:cancel-contract-failed`],
      };
    }
    const exitDeadline = performance.now() + 2_000;
    while (isProcessAlive(childPid) && performance.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const available = !isProcessAlive(childPid);
    return {
      available,
      evidence: [
        `process-tree:${process.platform}:${available ? "verified" : "descendant-survived"}`,
      ],
    };
  } finally {
    controller.abort();
    if (childPid !== undefined && isProcessAlive(childPid)) terminateProcessTree(childPid);
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

function terminateProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Probe 创建的进程可能已在检查后自行退出。
  }
}

function normalizeEnvironment(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) return undefined;
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
