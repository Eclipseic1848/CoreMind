import { execa } from "execa";

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

    try {
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
        cancelSignal: request.signal,
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
      if (result.isCanceled || request.signal?.aborted) {
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
        request.signal?.aborted ? "process_aborted" : "process_spawn_failed",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
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
