import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const logPath = process.env.COREMIND_COMMAND_PROBE_LOG;
const targetArgs = ["-B", "-m", "unittest", "tests.test_price"];
const errorCode = (error) =>
  ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(error?.code)
    ? error.code
    : error
      ? "unknown"
      : null;
const bytes = (value) =>
  typeof value === "string" ? Buffer.byteLength(value, "utf8") : (value?.byteLength ?? 0);
if (logPath) {
  const original = childProcess.spawnSync;
  let sequence = 0;
  const emit = (kind, details = {}) => {
    const event = {
      schemaVersion: 1,
      kind,
      wallMs: Date.now(),
      monoMs: performance.now(),
      nodePid: process.pid,
      ...details,
    };
    try {
      appendFileSync(logPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    } catch (error) {
      // 诊断写入失败不能改变原调用；缺失的证据必须视为未知。
      try {
        process.stderr.write(`[command-probe] log_write_failed ${errorCode(error)}\n`);
      } catch {}
    }
  };
  childProcess.spawnSync = function (command, args, options) {
    if (
      command !== "python" ||
      !Array.isArray(args) ||
      args.length !== targetArgs.length ||
      !args.every((value, index) => value === targetArgs[index])
    ) {
      return Reflect.apply(original, this, arguments);
    }
    const callId = `${process.pid}:${++sequence}`;
    emit("spawn_sync_enter", {
      callId,
      cwd: options?.cwd ?? process.cwd(),
      timeoutMs: options?.timeout ?? null,
    });
    const startedMonoMs = performance.now();
    let result;
    try {
      result = Reflect.apply(original, this, arguments);
    } catch (error) {
      emit("spawn_sync_throw", {
        callId,
        startedMonoMs,
        durationMs: performance.now() - startedMonoMs,
        errorCode: errorCode(error),
      });
      throw error;
    }
    emit("spawn_sync_return", {
      callId,
      startedMonoMs,
      durationMs: performance.now() - startedMonoMs,
      result: {
        status: result.status ?? null,
        signal: result.signal ?? null,
        pid: result.pid ?? null,
        errorCode: errorCode(result.error),
        stdoutBytes: bytes(result.stdout),
        stderrBytes: bytes(result.stderr),
      },
    });
    return result;
  };
  syncBuiltinESMExports();
  emit("probe_ready", { nodeVersion: process.version, nodeExecutable: process.execPath });
}
