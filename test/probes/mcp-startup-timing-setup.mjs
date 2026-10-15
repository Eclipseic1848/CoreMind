import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect } from "vitest";

const root = process.cwd();
const same = (left, right) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
const target = path.resolve(root, "packages/coremind-runtime/src/mcp-runtime.acceptance.test.ts");
if (
  typeof expect.getState().testPath === "string" &&
  same(path.resolve(expect.getState().testPath), target)
) {
  const load = (name) =>
    import(pathToFileURL(path.join(root, "packages/coremind-tools/dist", name)).href);
  const { ManagedMcpClient } = await load("mcp-client.js");
  const { McpStdioTransport } = await load("mcp-stdio-transport.js");
  const fixture = path.resolve(root, "test/fixtures/mcp-stdio-server.mjs");
  const round = /^[1-3]$/.test(process.env.COREMIND_STABILITY_RUN ?? "")
    ? Number(process.env.COREMIND_STABILITY_RUN)
    : 0;
  const outputDirectory = path.resolve(root, ".scratch/mcp-startup");
  const outputFile = path.join(outputDirectory, "trace-win32-" + round + ".jsonl");
  const owners = new WeakMap(),
    tasks = new WeakMap();
  const nativeStages = [
    "ps_begin",
    "owner_connected",
    "frame_read",
    "utility_ready",
    "native_compiled",
    "job_spawned",
  ];
  const stages = new Set([
    "fixture_enter",
    "fixture_ready",
    "fixture_abort",
    "run_settled",
    "cleanup_done",
    "connect_gate_release",
    "list_gate_enter",
    "observed",
    "runtime_invoke_begin",
    "runtime_env_done",
    "runtime_identity_done",
    "runtime_executing",
    "transport_domain_begin",
    "domain_resolve_begin",
    "domain_resolve_done",
    "transport_sdk_begin",
    "transport_sdk_done",
    "job_launch_begin",
    "job_launch_done",
    "job_ready_wait",
    "job_ready_done",
    "job_prepare_begin",
    "owner_listen_ready",
    "service_listen_ready",
    "helper_spawned",
    "owner_socket_connected",
    "owner_job_ready",
    "service_socket_connected",
    "service_ready",
    "process_probe_begin",
    "process_probe_no_pid",
    "process_probe_pid_seen",
    "process_probe_abort",
    "process_probe_joined",
    "process_probe_bad_cancel",
    "process_probe_descendants_gone",
    "process_probe_descendant_survived",
    "process_probe_finally",
    "client_connect_begin",
    "client_connect_fulfilled",
    "client_connect_rejected",
    "client_connect_threw",
    "transport_start_begin",
    "transport_start_fulfilled",
    "transport_start_rejected",
    "transport_start_threw",
    "transport_owner_abort",
    "windows_job_observed",
    "windows_job_ready_fulfilled",
    "windows_job_ready_rejected",
    "send_initialize",
    "send_server_discover",
    "test_signal_abort",
    "after_each",
    ...nativeStages.map((name) => "native_" + name),
  ]);
  let current,
    scopeCount = 0,
    outputBytes = 0;
  const storage = new AsyncLocalStorage();
  const reference = (value) =>
    (typeof value === "object" && value !== null) || typeof value === "function";
  const noop = () => {};
  noop.stderr = noop;
  noop.run = (callback) => callback();
  function mark(scope, stage) {
    if (!stages.has(stage)) return;
    if (scope.entries.length === 64) scope.entries.shift();
    scope.entries.push({ stage, elapsedMs: Number((performance.now() - scope.began).toFixed(3)) });
    if (stage !== "test_signal_abort" && stage !== "after_each") scope.touched = true;
  }
  function alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === "ESRCH" ? false : error?.code === "EPERM" ? true : null;
    }
  }
  function sampleFixture(scope, at) {
    if (!scope.recordFile || (at === "cleanup_done" && scope.fixture?.status === "sampled")) return;
    const remaining = 1024 * 1024 - scope.readBytes;
    if (remaining <= 0) return;
    let descriptor;
    try {
      descriptor = openSync(scope.recordFile, "r");
      if (fstatSync(descriptor).size > remaining) {
        if (scope.fixture?.status !== "sampled") scope.fixture = { status: "over_limit" };
        return;
      }
      const bytes = Buffer.alloc(remaining);
      const length = readSync(descriptor, bytes, 0, bytes.length, 0);
      scope.readBytes += length;
      const counts = {
        status: "sampled",
        at,
        started: 0,
        childReady: 0,
        initialize: 0,
        serverDiscover: 0,
        rootAlive: null,
        childAlive: null,
      };
      for (const line of bytes.toString("utf8", 0, length).split("\n")) {
        try {
          const value = JSON.parse(line);
          if (value.type === "started") {
            counts.started++;
            counts.rootAlive = alive(value.pid);
            counts.childAlive = alive(value.childPid);
          }
          if (value.type === "child-ready") counts.childReady++;
          if (value.type === "request" && value.method === "initialize") counts.initialize++;
          if (value.type === "request" && value.method === "server/discover")
            counts.serverDiscover++;
        } catch {
          /* 追加中的不完整末行不算完整证据。 */
        }
      }
      scope.fixture = counts;
    } catch {
      if (scope.fixture?.status !== "sampled") scope.fixture = { status: "unavailable" };
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          /* 只读诊断不能改变原清理结果。 */
        }
      }
    }
  }
  function emit(scope, reason) {
    if (!scope.touched || scope.outputs >= 2) return;
    sampleFixture(scope, reason);
    const body = JSON.stringify({
      round,
      case: scope.ordinal,
      reason,
      state: scope.state,
      counters: scope.counters,
      entries: scope.entries,
      fixture: scope.fixture ?? { status: "not_identified" },
    });
    const line = body + "\n",
      summary = "COREMIND_MCP_STARTUP_TIMING " + body;
    const bytes = Buffer.byteLength(line, "utf8") + Buffer.byteLength(summary + "\n", "utf8");
    if (outputBytes + bytes > 2 * 1024 * 1024) return;
    outputBytes += bytes;
    scope.outputs++;
    try {
      mkdirSync(outputDirectory, { recursive: true });
      appendFileSync(outputFile, line, "utf8");
    } catch {
      /* 工件不可写时仍保留安全控制台摘要。 */
    }
    try {
      console.log(summary);
    } catch {
      /* 诊断输出不能改变测试状态。 */
    }
  }
  function makeScope() {
    if (scopeCount === 128) return undefined;
    const scope = {
      ordinal: ++scopeCount,
      began: performance.now(),
      entries: [],
      counters: {},
      state: "run",
      touched: false,
      outputs: 0,
      readBytes: 0,
      timers: new Set(),
      removers: [],
    };
    scope.trace = (stage) => {
      mark(scope, stage);
      if (stage === "cleanup_done" && scope.outputs === 1) emit(scope, "cleanup_done");
    };
    scope.trace.run = (callback) => storage.run(scope, callback);
    let tail = "",
      markers = 0;
    scope.trace.stderr = (chunk) => {
      if (typeof chunk !== "string" && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array))
        return;
      for (let index = 0; index < chunk.length; index++) {
        const byte = typeof chunk === "string" ? chunk.charCodeAt(index) : chunk[index];
        if (byte > 127) {
          tail = "";
          continue;
        }
        tail = (tail + String.fromCharCode(byte)).slice(-64);
        if (byte !== 93) continue;
        for (const stage of nativeStages) {
          if (markers < 24 && tail.endsWith("[CM_MCP_STAGE:" + stage + "]")) {
            markers++;
            scope.trace("native_" + stage);
            break;
          }
        }
        tail = "";
      }
    };
    return scope;
  }
  function capture(owner, linkedOwner) {
    const scope =
      (reference(owner) ? owners.get(owner) : undefined) ??
      (reference(linkedOwner) ? owners.get(linkedOwner) : undefined) ??
      storage.getStore() ??
      current;
    if (!scope) return noop;
    if (reference(owner) && !owners.has(owner)) owners.set(owner, scope);
    if (reference(linkedOwner) && !owners.has(linkedOwner)) owners.set(linkedOwner, scope);
    return scope.trace;
  }
  // 纯内存校验跨用例 await 的归属，不生成真实用例编号或输出。
  const savedScopeCount = scopeCount,
    savedCurrent = current;
  let releaseGate, originalPromise;
  try {
    const oldScope = makeScope(),
      newScope = makeScope();
    assert.ok(oldScope && newScope);
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    current = oldScope;
    const returned = oldScope.trace.run(() => {
      originalPromise = (async () => {
        await gate;
        const trace = capture();
        assert.strictEqual(trace, oldScope.trace);
        trace("observed");
      })();
      return originalPromise;
    });
    assert.strictEqual(returned, originalPromise);
    current = newScope;
    releaseGate();
    await returned;
    assert.deepEqual(
      oldScope.entries.map((entry) => entry.stage),
      ["observed"],
    );
    assert.equal(newScope.entries.length, 0);
  } finally {
    releaseGate?.();
    await originalPromise?.catch(() => {});
    scopeCount = savedScopeCount;
    current = savedCurrent;
  }
  globalThis[Symbol.for("coremind.mcpStartup.capture")] = capture;
  const count = (scope, key) => {
    scope.counters[key] = (scope.counters[key] ?? 0) + 1;
  };
  function wrap(prototype, name, prefix, before) {
    const original = prototype[name];
    prototype[name] = function (...args) {
      const trace = capture(this, this.options?.transport),
        scope = owners.get(this);
      if (!scope) return Reflect.apply(original, this, args);
      count(scope, prefix);
      trace(prefix + "_begin");
      const finish = before?.call(this, scope) ?? noop;
      let result;
      try {
        result = scope.trace.run(() => Reflect.apply(original, this, args));
      } catch (error) {
        finish();
        trace(prefix + "_threw");
        throw error;
      }
      Promise.resolve(result).then(
        () => {
          finish();
          trace(prefix + "_fulfilled");
        },
        () => {
          finish();
          trace(prefix + "_rejected");
        },
      );
      return result;
    };
  }
  wrap(ManagedMcpClient.prototype, "connect", "client_connect");
  wrap(McpStdioTransport.prototype, "start", "transport_start", function (scope) {
    const args = this.options?.args;
    if (
      Array.isArray(args) &&
      typeof args[0] === "string" &&
      same(path.resolve(args[0]), fixture) &&
      typeof args[1] === "string" &&
      path.isAbsolute(args[1]) &&
      path.basename(args[1]) === "service.jsonl" &&
      path.basename(path.dirname(args[1])).startsWith("coremind-mcp-acceptance-")
    )
      scope.recordFile = args[1];
    const onAbort = () => {
      scope.trace("transport_owner_abort");
      sampleFixture(scope, "transport_owner_abort");
    };
    if (scope.removers.length < 64) {
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      scope.removers.push(() => this.controller.signal.removeEventListener("abort", onAbort));
    }
    let watched = false;
    const peek = () => {
      if (watched || !this.windowsJob) return;
      watched = true;
      count(scope, "windows_job");
      scope.trace("windows_job_observed");
      Promise.resolve(this.windowsJob.ready).then(
        () => scope.trace("windows_job_ready_fulfilled"),
        () => scope.trace("windows_job_ready_rejected"),
      );
    };
    const timer = scope.timers.size < 64 ? setInterval(peek, 20) : undefined;
    timer?.unref();
    if (timer) scope.timers.add(timer);
    return () => {
      peek();
      if (timer) {
        clearInterval(timer);
        scope.timers.delete(timer);
      }
    };
  });
  const originalSend = McpStdioTransport.prototype.send;
  McpStdioTransport.prototype.send = function (...args) {
    const scope = owners.get(this),
      method = args[0]?.method;
    if (scope && (method === "initialize" || method === "server/discover")) {
      const stage = method === "initialize" ? "send_initialize" : "send_server_discover";
      count(scope, stage);
      scope.trace(stage);
    }
    return Reflect.apply(originalSend, this, args);
  };
  beforeEach((context) => {
    current = makeScope();
    if (!current) return;
    const scope = current;
    tasks.set(context.task, scope);
    const onAbort = () => scope.trace("test_signal_abort");
    context.signal.addEventListener("abort", onAbort, { once: true });
    scope.removers.push(() => context.signal.removeEventListener("abort", onAbort));
    if (context.signal.aborted) onAbort();
  });
  afterEach((context) => {
    const scope = tasks.get(context.task);
    if (!scope) return;
    for (const timer of scope.timers) clearInterval(timer);
    scope.timers.clear();
    for (const remove of scope.removers.splice(0)) remove();
    const state = context.task.result?.state;
    scope.state = ["run", "pass", "fail", "skip", "todo", "queued"].includes(state)
      ? state
      : "unknown";
    scope.trace("after_each");
    emit(scope, "after_each");
    if (current === scope) current = undefined;
  });
}
