import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [recordPath, mode = "normal"] = process.argv.slice(2);
if (!recordPath) throw new Error("缺少夹具记录路径");
const record = (value) => appendFileSync(recordPath, `${JSON.stringify(value)}\n`, "utf8");
const childScript = [
  "const { appendFileSync } = require('node:fs')",
  `const record = (value) => appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(value) + '\\n', 'utf8')`,
  "record({ type: 'child-ready', pid: process.pid })",
  "process.send({ ready: true })",
  "setInterval(() => record({ type: 'heartbeat', pid: process.pid }), 50)",
  "process.on('disconnect', () => record({ type: 'parent-disconnected', pid: process.pid }))",
  "process.on('exit', (code) => record({ type: 'child-exit', pid: process.pid, code }))",
].join(";");
const child = spawn(process.execPath, ["-e", childScript], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
  detached: process.platform === "win32" && mode === "orphan",
  windowsHide: true,
});
const childReady = new Promise((resolve, reject) => {
  child.once("message", resolve);
  child.once("error", reject);
});
record({ type: "started", pid: process.pid, childPid: child.pid });
record({
  type: "environment",
  allowed: process.env.MCP_TEST_SECRET !== undefined,
  forbidden: process.env.COREMIND_MCP_UNLISTED !== undefined,
});
let modern = false;
const inputSchema = {
  type: "object",
  $defs: { value: {} },
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  additionalProperties: false,
};
const tool = (name) => ({
  name,
  description: mode === "secret-schema" ? process.env.MCP_TEST_SECRET : `本地夹具 ${name}`,
  inputSchema,
});
const respond = (id, result) => {
  const value = modern ? { resultType: "complete", ...result } : result;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`);
};
const interface_ = createInterface({ input: process.stdin });
interface_.on("line", async (line) => {
  const request = JSON.parse(line);
  record({ type: "request", method: request.method, params: request.params });
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    await childReady;
    if (mode === "bad-init") {
      respond(request.id, { protocolVersion: "unsupported" });
      return;
    }
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "stdio-fixture", version: "1.0.0" },
    });
  } else if (request.method === "server/discover") {
    await childReady;
    modern = true;
    respond(request.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: { listChanged: true } },
      ttlMs: 0,
      cacheScope: "private",
    });
  } else if (request.method === "tools/list") {
    const second = request.params?.cursor === "second";
    respond(request.id, {
      tools: [tool(second ? "write_once" : "echo")],
      ...(!second || mode === "page-loop" ? { nextCursor: "second" } : {}),
      ...(modern ? { ttlMs: 0, cacheScope: "private" } : {}),
    });
  } else if (request.method === "tools/call") {
    if (mode === "secret-stderr") process.stderr.write(process.env.MCP_TEST_SECRET);
    if (mode === "hang") return;
    if (mode === "effect-then-hang" && request.params.name === "write_once") {
      record({ type: "effect" });
      return;
    }
    if (mode === "bad-json") {
      process.stdout.write("bad-json\n");
      return;
    }
    if (mode === "invalid-utf8") {
      process.stdout.write(Buffer.from([0xff, 0x0a]));
      return;
    }
    if (mode === "oversize") {
      process.stdout.write("x".repeat(9 * 1024 * 1024));
      return;
    }
    if (mode === "stderr") {
      process.stderr.write("x".repeat(128 * 1024));
      return;
    }
    if (mode === "header-mismatch" || mode === "secret-error") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32020, message: mode === "secret-error" ? process.env.MCP_TEST_SECRET : "header mismatch" } })}\n`,
      );
      return;
    }
    if (mode === "input-required") {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { resultType: "input_required", inputRequests: {}, requestState: "opaque" } })}\n`,
      );
      return;
    }
    if (mode === "change")
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n`,
      );
    if (mode === "secret-number" || mode === "secret-joined") {
      respond(
        request.id,
        mode === "secret-number"
          ? { content: [], structuredContent: { result: Number(process.env.MCP_TEST_SECRET) } }
          : {
              content: process.env.MCP_TEST_SECRET.split("\n").map((text) => ({
                type: "text",
                text,
              })),
            },
      );
      return;
    }
    if (request.params.name === "write_once") record({ type: "effect" });
    const value =
      mode === "secret-key"
        ? { [process.env.MCP_TEST_SECRET]: false }
        : mode === "secret-result"
          ? process.env.MCP_TEST_SECRET
          : request.params.arguments.value;
    const structuredContent =
      modern || (value !== null && typeof value === "object" && !Array.isArray(value))
        ? value
        : { result: value };
    respond(request.id, {
      content:
        mode === "unsupported"
          ? [{ type: "image", data: "AA==", mimeType: "image/png" }]
          : [{ type: "text", text: JSON.stringify(value) }],
      structuredContent,
      ...(mode === "tool-error" ? { isError: true } : {}),
    });
    if (mode === "orphan") process.stdout.write("", () => process.exit(0));
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "未知夹具方法" } })}\n`,
    );
  }
});
interface_.on("close", () => process.exit(0));
