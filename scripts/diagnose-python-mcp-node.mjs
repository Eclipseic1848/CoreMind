// 临时诊断：仅固定 Worker 入口启用；日志在正常退出时一次写入，硬终止可能丢失。
// 由宿主提供绝对 COREMIND_NODE_OBSERVER_LOG；不记录参数、环境、路径或错误正文。
import childProcess from "node:child_process";
import { channel } from "node:diagnostics_channel";
import { errorMonitor } from "node:events";
import { appendFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const destination = process.env.COREMIND_NODE_OBSERVER_LOG;
const workerEntry = path.basename(process.argv[1] ?? "") === "coremind-worker.mjs";
if (workerEntry && typeof destination === "string" && path.isAbsolute(destination)) {
  const rows = [];
  const origin = performance.now();
  let sequence = 0;
  let childSequence = 0;
  const knownExecutables = new Set([
    "node", "node.exe", "taskkill", "taskkill.exe", "host.exe",
    "cmd.exe", "powershell.exe", "pwsh", "pwsh.exe",
  ]);
  const basename = (value) => {
    const name = typeof value === "string" ? path.win32.basename(value).toLowerCase() : "";
    return knownExecutables.has(name) ? name : "other";
  };
  const record = (event) => {
    try {
      rows.push(JSON.stringify({
        schemaVersion: 1, sequence: ++sequence, pid: process.pid,
        atMs: Date.now(), sinceMs: performance.now() - origin, ...event,
      }) + "\n");
    } catch {
      // 观察失败不改变被观察操作的结果。
    }
  };

  // 内置通道覆盖 Execa 的 spawn/execFile，不替换异步进程函数。
  channel("child_process").subscribe(({ process: child }) => {
    try {
      const childId = ++childSequence;
      const started = performance.now();
      const event = (type, extra = {}) => record({
        event: type, childId, exec: basename(child.spawnfile),
        childPid: Number.isInteger(child.pid) ? child.pid : null,
        durationMs: performance.now() - started, ...extra,
      });
      child.once("spawn", () => event("child_spawn"));
      child.once("exit", (code) => event("child_exit", {
        exitCode: Number.isInteger(code) ? code : null,
      }));
      child.once("close", (code) => event("child_close", {
        exitCode: Number.isInteger(code) ? code : null,
      }));
      // errorMonitor 不把原本未处理的 error 改成已处理。
      child.once(errorMonitor, () => event("child_error"));
    } catch {
      // 通道订阅器必须保持不抛错。
    }
  });

  // 同步 taskkill 兜底没有 ChildProcess 通道，保留原 this、返回值及异常。
  const originalSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = function (...values) {
    const started = performance.now();
    const exec = basename(values[0]);
    record({ event: "spawn_sync_start", exec });
    try {
      return Reflect.apply(originalSpawnSync, this, values);
    } finally {
      record({ event: "spawn_sync_end", exec, durationMs: performance.now() - started });
    }
  };

  // 只给公开 open 返回的句柄增加不可枚举计时包装，不记录文件路径或 fd。
  const originalOpen = fsPromises.open;
  fsPromises.open = async function (...values) {
    const handle = await Reflect.apply(originalOpen, this, values);
    try {
      const originalSync = handle.sync;
      Object.defineProperty(handle, "sync", {
        configurable: true, writable: true, enumerable: false,
        value: async function (...syncValues) {
          const started = performance.now();
          let succeeded = false;
          try {
            const result = await Reflect.apply(originalSync, this, syncValues);
            succeeded = true;
            return result;
          } finally {
            const durationMs = performance.now() - started;
            if (durationMs > 50) record({ event: "file_sync_slow", durationMs, succeeded });
          }
        },
      });
    } catch {
      // 句柄若不允许包装，仍原样交还调用者。
    }
    return handle;
  };
  syncBuiltinESMExports();
  record({ event: "observer_ready" });

  // 热路径仅保存在内存，不增加文件 I/O；日志写入不参与 Run 的计时。
  process.once("exit", (code) => {
    record({ event: "observer_exit", exitCode: code });
    try {
      appendFileSync(destination, rows.join(""), { encoding: "utf8" });
    } catch {
      // 不用 stdout/stderr 回退，避免混入协议或泄露路径。
    }
  });
}
