import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach } from "vitest";

const root = process.cwd();
const load = (name) => import(pathToFileURL(path.join(root, "packages/coremind-tools/dist", name)).href);
const { ManagedMcpClient } = await load("mcp-client.js");
const { McpStdioTransport } = await load("mcp-stdio-transport.js");
const fixture = path.resolve(root, "test/fixtures/mcp-stdio-server.mjs");
const same = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
let began = performance.now(), entries = [], counters = {}, recordFile, fixtureCounts;
const timers = new Set(), removers = [];
const mark = (stage) => {
  if (entries.length === 64) entries.shift();
  entries.push({ stage, elapsedMs: Number((performance.now() - began).toFixed(3)) });
};
const count = (key) => { counters[key] = (counters[key] ?? 0) + 1; };
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "ESRCH" ? false : error?.code === "EPERM" ? true : null; }
}
function sampleFixture(at) {
  if (!recordFile || fixtureCounts?.status === "sampled") return;
  let descriptor;
  try {
    descriptor = openSync(recordFile, "r");
    if (fstatSync(descriptor).size > 1024 * 1024) { fixtureCounts = { status: "over_limit" }; return; }
    const bytes = Buffer.alloc(1024 * 1024);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    const counts = { status: "sampled", at, started: 0, childReady: 0, initialize: 0, serverDiscover: 0, rootAlive: null, childAlive: null };
    for (const line of bytes.toString("utf8", 0, length).split("\n")) {
      try {
        const value = JSON.parse(line);
        if (value.type === "started") { counts.started++; counts.rootAlive = alive(value.pid); counts.childAlive = alive(value.childPid); }
        if (value.type === "child-ready") counts.childReady++;
        if (value.type === "request" && value.method === "initialize") counts.initialize++;
        if (value.type === "request" && value.method === "server/discover") counts.serverDiscover++;
      } catch { /* 并发追加中的末行不作为完整证据。 */ }
    }
    fixtureCounts = counts;
  } catch { fixtureCounts = { status: "unavailable" }; }
  finally { if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* 诊断读取不能影响原清理结果。 */ } } }
}
function wrap(prototype, name, prefix, before) {
  const original = prototype[name];
  prototype[name] = function (...args) {
    count(prefix); mark(prefix + "_begin");
    const finish = before?.call(this, args) ?? (() => {});
    let result;
    try { result = Reflect.apply(original, this, args); }
    catch (error) { finish(); mark(prefix + "_threw"); throw error; }
    Promise.resolve(result).then(
      () => { finish(); mark(prefix + "_fulfilled"); },
      () => { finish(); mark(prefix + "_rejected"); },
    );
    return result;
  };
}
wrap(ManagedMcpClient.prototype, "connect", "client_connect");
wrap(McpStdioTransport.prototype, "start", "transport_start", function () {
  const args = this.options?.args;
  if (Array.isArray(args) && typeof args[0] === "string" && same(path.resolve(args[0]), fixture) &&
      typeof args[1] === "string" && path.isAbsolute(args[1]) && path.basename(args[1]) === "service.jsonl" &&
      path.basename(path.dirname(args[1])).startsWith("coremind-mcp-acceptance-")) recordFile = args[1];
  const onAbort = () => { mark("transport_owner_abort"); sampleFixture("transport_owner_abort"); };
  if (removers.length < 64) { this.controller.signal.addEventListener("abort", onAbort, { once: true }); removers.push(() => this.controller.signal.removeEventListener("abort", onAbort)); }
  let watched = false;
  const peek = () => {
    if (watched || !this.windowsJob) return;
    watched = true; count("windows_job"); mark("windows_job_observed");
    Promise.resolve(this.windowsJob.ready).then(() => mark("windows_job_ready_fulfilled"), () => mark("windows_job_ready_rejected"));
  };
  const timer = timers.size < 64 ? setInterval(peek, 20) : undefined;
  timer?.unref(); if (timer) timers.add(timer);
  return () => { peek(); if (timer) { clearInterval(timer); timers.delete(timer); } };
});
const originalSend = McpStdioTransport.prototype.send;
McpStdioTransport.prototype.send = function (...args) {
  const method = args[0]?.method;
  if (method === "initialize" || method === "server/discover") {
    const stage = method === "initialize" ? "send_initialize" : "send_server_discover";
    count(stage); mark(stage);
  }
  return Reflect.apply(originalSend, this, args);
};
beforeEach(() => { began = performance.now(); entries = []; counters = {}; recordFile = undefined; fixtureCounts = undefined; });
afterEach(() => {
  for (const timer of timers) clearInterval(timer); timers.clear();
  for (const remove of removers.splice(0)) remove();
  sampleFixture("after_each"); mark("after_each");
  console.log("COREMIND_MCP_STARTUP_TIMING " + JSON.stringify({ counters, entries, fixture: fixtureCounts ?? { status: "not_identified" } }));
});
