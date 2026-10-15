import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
let execa;

// 一次性预取消诊断；不启动业务，不把诊断通过当作生产验收。
const prefix = "COREMIND_MCP_STARTUP_STAGE:";
const stages = new Set(["ps_begin", "owner_connected", "compiled", "config_received", "closed_sent"]);
const report = { diagnosticOnly: true, passed: false, code: "bootstrap_failed", events: [], nonMarkerStderrBytes: 0, stdoutBytes: 0, recordsTruncated: false };
let started = performance.now();
const mark = (stage, exitCode) => {
  if (report.events.length >= 24) { report.recordsTruncated = true; return; }
  report.events.push({ stage, tMs: Number((performance.now() - started).toFixed(3)), ...(exitCode === undefined ? {} : { exitCode }) });
};
const fault = (code) => Object.assign(new Error("startup_probe_failed"), { probeCode: code });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
};
let directory, server, socket, helper, helperFinished, timer;
let ending = false, accepted = false, serverClosed = false, provedClosed = false;
const stopped = deferred();
const listened = deferred();
const ownerClosed = deferred();
const failed = deferred();
let pending = Buffer.alloc(0);
let stderrBytes = 0, markerBytes = 0, lineLength = 0, line = "", lineOverflow = false;
const seen = new Set();
const readStderr = (chunk) => {
  stderrBytes += chunk.length;
  for (const byte of chunk) {
    lineLength++;
    if (byte === 10) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      const stage = text.startsWith(prefix) ? text.slice(prefix.length) : "";
      if (!lineOverflow && stages.has(stage)) {
        markerBytes += lineLength;
        seen.add(stage);
        mark(stage);
      }
      line = ""; lineLength = 0; lineOverflow = false;
    } else if (line.length < 128) line += String.fromCharCode(byte);
    else lineOverflow = true;
  }
};

try {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw fault("invalid_arguments");
  if (process.platform !== "win32") throw fault("unsupported_platform");
  ({ execa } = await import("execa"));
  const buildRoot = process.argv[2];
  const module = await import(pathToFileURL(path.join(buildRoot, "packages/coremind-tools/dist/windows-mcp-job-script.js")).href);
  let script = module.WINDOWS_MCP_JOB_SCRIPT;
  if (typeof script !== "string") throw fault("invalid_script");
  const insert = (anchor, replacement) => {
    if (script.split(anchor).length !== 2) throw fault("script_anchor_failed");
    script = script.replace(anchor, replacement);
  };
  const marker = (stage) => "[Console]::Error.WriteLine('" + prefix + stage + "')";
  insert("$status = 1\ntry {", "$status = 1\n" + marker("ps_begin") + "\ntry {");
  insert("  $pipe.Connect(5000)\n", "  $pipe.Connect(5000)\n  " + marker("owner_connected") + "\n");
  insert("'@\n  $line = [CoreMindMcpJob]::ReadFrame($pipe)", "'@\n  " + marker("compiled") + "\n  $line = [CoreMindMcpJob]::ReadFrame($pipe)");
  insert("  $config = ConvertFrom-Json -InputObject $line\n", "  $config = ConvertFrom-Json -InputObject $line\n  " + marker("config_received") + "\n");
  const cancelAnchor = "    [CoreMindMcpJob]::Send($pipe, '{\"type\":\"closed\",\"activeProcesses\":0}')\n  } else {";
  insert(cancelAnchor, "    [CoreMindMcpJob]::Send($pipe, '{\"type\":\"closed\",\"activeProcesses\":0}')\n    " + marker("closed_sent") + "\n  } else {");
  const hostEnv = {};
  for (const name of ["SystemRoot", "windir", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP"]) {
    const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry?.[1] !== undefined) hostEnv[name] = entry[1];
  }
  const windowsDirectory = [hostEnv.SystemRoot, hostEnv.windir].find((value) => value && /^[a-z]:[/\\]/iu.test(path.win32.parse(value).root));
  if (!windowsDirectory) throw fault("invalid_system_root");
  const executable = path.win32.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  // 参数固定且没有空格；按带引号的程序路径保守核对 CreateProcess 的总字符数。
  const commandLineLength = executable.length + 2 + 1 + args.join(" ").length + 1;
  if (commandLineLength >= 32767) throw fault("command_line_too_long");
  report.commandLineLength = commandLineLength;
  directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-startup-probe-"));
  const name = "coremind-mcp-owner-" + randomUUID();
  started = performance.now();
  const timedOut = new Promise((_, reject) => { timer = setTimeout(() => reject(fault("deadline")), 5_000); });
  const work = (async () => {
    server = createServer((connection) => {
      if (accepted || ending) { connection.destroy(); return; }
      accepted = true; socket = connection; mark("owner_connect");
      server.close();
      socket.on("data", (chunk) => {
        if (pending.length + chunk.length > 1024 * 1024) { failed.reject(fault("owner_frame_failed")); return; }
        pending = Buffer.concat([pending, chunk]);
        const newline = pending.indexOf(10);
        if (newline < 0) return;
        try {
          if (newline !== pending.length - 1 || provedClosed) throw fault("owner_frame_failed");
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pending.subarray(0, newline)));
          pending = Buffer.alloc(0);
          if (value?.type === "error") throw fault("owner_error");
          if (value?.type !== "closed" || value.activeProcesses !== 0 || Object.keys(value).sort().join(",") !== "activeProcesses,type") throw fault("owner_frame_failed");
          provedClosed = true; mark("owner_closed"); ownerClosed.resolve();
        } catch (error) { failed.reject(error?.probeCode ? error : fault("owner_frame_failed")); }
      });
      socket.once("error", () => failed.reject(fault("owner_socket_failed")));
      socket.once("close", () => { mark("owner_socket_closed"); if (!provedClosed) failed.reject(fault("owner_eof")); });
      socket.write('{"cancel":true}\n', (error) => {
        mark("config_write_callback");
        if (error) failed.reject(fault("owner_write_failed"));
      });
    });
    server.once("close", () => { serverClosed = true; mark("endpoints_closed"); stopped.resolve(); });
    server.on("error", () => failed.reject(fault("owner_listen_failed")));
    await new Promise((resolve, reject) => {
      server.once("error", () => { listened.resolve(); reject(fault("owner_listen_failed")); });
      server.listen("\\\\.\\pipe\\" + name, () => { listened.resolve(); resolve(); });
    });
    mark("owner_listening");
    if (ending) throw fault("deadline");
    helper = execa(executable, args, {
      cwd: directory, env: { ...hostEnv, COREMIND_MCP_OWNER_PIPE: name }, extendEnv: false,
      shell: false, stdin: "pipe", stdout: "pipe", stderr: "pipe", encoding: "buffer",
      buffer: false, stripFinalNewline: false, reject: false, windowsHide: true,
      cleanup: false, killDescendants: false,
    });
    helper.nodeChildProcess.once("spawn", () => { mark("helper_spawn"); if (ending) helper.nodeChildProcess.kill("SIGKILL"); });
    helper.nodeChildProcess.once("exit", (code) => mark("helper_exit", code));
    helper.nodeChildProcess.once("close", (code) => mark("helper_close", code));
    helper.stdout.on("data", (chunk) => { report.stdoutBytes += chunk.length; });
    helper.stderr.on("data", readStderr);
    helperFinished = helper.then((result) => {
      mark("helper_finished", result.exitCode ?? null);
      if (result.failed || result.exitCode !== 0) throw fault("helper_failed");
    }, () => { mark("helper_finished", null); throw fault("helper_failed"); });
    await Promise.all([ownerClosed.promise, helperFinished, stopped.promise]);
  })();
  void work.catch(() => {});
  await Promise.race([work, failed.promise, timedOut]);
  if (performance.now() - started >= 5_000) throw fault("deadline");
  if (seen.size !== stages.size || report.recordsTruncated) throw fault("stage_evidence_incomplete");
  report.passed = true; report.code = "complete";
} catch (error) {
  const codes = new Set(["invalid_arguments", "unsupported_platform", "invalid_script", "script_anchor_failed", "invalid_system_root", "command_line_too_long", "deadline", "owner_frame_failed", "owner_error", "owner_socket_failed", "owner_eof", "owner_write_failed", "owner_listen_failed", "helper_failed", "stage_evidence_incomplete"]);
  report.code = codes.has(error?.probeCode) ? error.probeCode : "bootstrap_failed";
} finally {
  try {
  ending = true;
  if (timer) clearTimeout(timer);
  if (helper && helper.nodeChildProcess.exitCode === null && helper.nodeChildProcess.signalCode === null) {
    mark("cleanup_kill"); helper.nodeChildProcess.kill("SIGKILL");
  }
  socket?.destroy();
  if (server && !serverClosed) {
    await listened.promise;
    if (server.listening) server.close();
    else if (!accepted) server.close(() => stopped.resolve());
    await stopped.promise;
  }
  if (helper) {
    helper.stdin?.destroy(); helper.stdout?.destroy(); helper.stderr?.destroy();
    try { await helperFinished; } catch { report.passed = false; if (report.code === "complete") report.code = "helper_failed"; }
  }
  } catch { report.passed = false; report.code = "cleanup_failed"; }
  report.nonMarkerStderrBytes = stderrBytes - markerBytes;
  report.elapsedMs = Number((performance.now() - started).toFixed(3));
  if (directory) {
    try { await writeFile(path.join(directory, "proof.json"), JSON.stringify(report), "utf8"); }
    catch { report.passed = false; report.code = "report_write_failed"; }
  }
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.passed ? 0 : 1;
}
