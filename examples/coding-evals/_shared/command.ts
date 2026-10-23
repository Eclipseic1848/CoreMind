import { spawnSync } from "node:child_process";
import path from "node:path";

export const commandTimeoutMs = 30_000;

// setup-python 固定了解释器目录时直接使用绝对路径，避免依赖 PATH 搜索结果。
export function pythonCommand(): string {
  const location = process.env.pythonLocation;
  if (!location) {
    return "python";
  }
  return path.join(location, process.platform === "win32" ? "python.exe" : "bin/python");
}

export function runCodingCommand(
  cwd: string,
  request: { command: string; args: string[] },
  timeoutMs = commandTimeoutMs,
) {
  const startedAt = Date.now();
  const result = spawnSync(request.command, request.args, {
    cwd,
    stdio: "pipe",
    timeout: timeoutMs,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    exitCode: result.status,
    durationMs: Date.now() - startedAt,
    errorCode: code
      ? ["ENOENT", "ETIMEDOUT", "EACCES", "EPERM", "ENOBUFS"].includes(code)
        ? code
        : "unknown"
      : null,
    signal: result.signal,
    pid: result.pid > 0 ? result.pid : null,
    stdoutBytes: result.stdout?.byteLength ?? 0,
    stderrBytes: result.stderr?.byteLength ?? 0,
  };
}
