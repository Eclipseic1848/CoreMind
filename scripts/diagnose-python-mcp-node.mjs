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
    "node",
    "node.exe",
    "taskkill",
    "taskkill.exe",
    "host.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
  ]);
  const basename = (value) => {
    const name = typeof value === "string" ? path.win32.basename(value).toLowerCase() : "";
    return knownExecutables.has(name) ? name : "other";
  };
  const record = (event) => {
    try {
      rows.push(
        JSON.stringify({
          schemaVersion: 1,
          sequence: ++sequence,
          pid: process.pid,
          atMs: Date.now(),
          sinceMs: performance.now() - origin,
          ...event,
        }) + "\n",
      );
    } catch {
      // 观察失败不改变被观察操作的结果。
    }
  };

  // 仅观察原有 20 秒计时器；Proxy 保留原函数属性与非匹配调用。
  const watchedTimers = new Map();
  let timerSequence = 0;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = new Proxy(originalSetTimeout, {
    apply(target, receiver, values) {
      const [callback, delay] = values;
      if (delay !== 20_000 || typeof callback !== "function") {
        return Reflect.apply(target, receiver, values);
      }
      const timerId = ++timerSequence;
      const started = performance.now();
      let runGuard = false;
      try {
        runGuard = Function.prototype.toString.call(callback).includes("run_timeout");
      } catch {
        // 不让分类失败改变定时器行为。
      }
      let timer;
      const wrapped = [...values];
      wrapped[0] = function (...callbackValues) {
        watchedTimers.delete(timer);
        record({
          event: "timer_fired",
          timerId,
          runGuard,
          durationMs: performance.now() - started,
        });
        return Reflect.apply(callback, this, callbackValues);
      };
      timer = Reflect.apply(target, receiver, wrapped);
      watchedTimers.set(timer, { timerId, runGuard, started });
      record({ event: "timer_scheduled", timerId, runGuard, delayMs: delay });
      return timer;
    },
  });
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = new Proxy(originalClearTimeout, {
    apply(target, receiver, values) {
      const observation = watchedTimers.get(values[0]);
      const result = Reflect.apply(target, receiver, values);
      if (observation) {
        watchedTimers.delete(values[0]);
        record({
          event: "timer_cleared",
          timerId: observation.timerId,
          runGuard: observation.runGuard,
          durationMs: performance.now() - observation.started,
        });
      }
      return result;
    },
  });

  // 内置通道覆盖 Execa 的 spawn/execFile，不替换异步进程函数。
  channel("child_process").subscribe(({ process: child }) => {
    try {
      const childId = ++childSequence;
      const started = performance.now();
      const event = (type, extra = {}) =>
        record({
          event: type,
          childId,
          exec: basename(child.spawnfile),
          childPid: Number.isInteger(child.pid) ? child.pid : null,
          durationMs: performance.now() - started,
          ...extra,
        });
      child.once("spawn", () => event("child_spawn"));
      child.once("exit", (code) =>
        event("child_exit", {
          exitCode: Number.isInteger(code) ? code : null,
        }),
      );
      child.once("close", (code) =>
        event("child_close", {
          exitCode: Number.isInteger(code) ? code : null,
        }),
      );
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

  // 只给公开 open 返回的句柄增加不可枚举计时包装；后缀分类不包含路径或 fd。
  let syncSequence = 0;
  const originalOpen = fsPromises.open;
  fsPromises.open = async function (...values) {
    const handle = await Reflect.apply(originalOpen, this, values);
    const suffix = typeof values[0] === "string" ? values[0] : "";
    const fileClass = suffix.endsWith(".jsonl")
      ? "stable_jsonl"
      : suffix.endsWith(".tmp")
        ? "atomic_temporary"
        : "other";
    try {
      const originalSync = handle.sync;
      Object.defineProperty(handle, "sync", {
        configurable: true,
        writable: true,
        enumerable: false,
        value: async function (...syncValues) {
          const syncId = ++syncSequence;
          const started = performance.now();
          let succeeded = false;
          record({ event: "file_sync_start", syncId, fileClass });
          try {
            const result = await Reflect.apply(originalSync, this, syncValues);
            succeeded = true;
            return result;
          } finally {
            record({
              event: "file_sync_end",
              syncId,
              fileClass,
              durationMs: performance.now() - started,
              succeeded,
            });
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
