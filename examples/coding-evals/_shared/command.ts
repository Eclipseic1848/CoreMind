import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

export const commandTimeoutMs = 30_000;

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
  const commandResult = {
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
  try {
    writeSync(
      2,
      `${JSON.stringify({
        kind: "windows_ci_command_window",
        startUtcMs: startedAt,
        returnUtcMs: startedAt + commandResult.durationMs,
        command: request.command,
        ...commandResult,
      })}\n`,
    );
  } catch {
    // 观测缺失视为 unknown，不改变原命令结果。
  }
  return commandResult;
}
