import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ProtocolV2SessionClient } from "coremind-ai";
import { ERROR_CODES } from "coremind-protocol";

const input = JSON.parse(await readFile(process.argv[2], "utf8"));
const child = spawn(
  process.execPath,
  [fileURLToPath(new URL("task-session-host.mjs", import.meta.url)), input.workspace],
  {
    stdio: ["pipe", "pipe", "pipe"],
  },
);
const pending = new Map();
let ordinal = 0;
let stderr = "";
child.stderr.setEncoding("utf8").on("data", (chunk) => {
  stderr += chunk;
});
const exited = new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => {
    for (const entry of pending.values()) entry.reject(new Error(`Worker exit ${code}: ${stderr}`));
    resolve(code);
  });
});
createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
  const message = JSON.parse(line);
  const entry = pending.get(message.id);
  if (entry)
    message.error
      ? entry.reject(Object.assign(new Error(message.error.message), message.error))
      : entry.resolve(message.result);
});
async function request(method, params) {
  const id = ++ordinal;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`RPC ${method} exceeded 10 seconds`)), 10_000);
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", ...(method === "initialize" ? {} : { protocolVersion: "2.0" }), id, method, params })}\n`,
      );
    });
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}
try {
  const initialized = await request("initialize", {
    protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
    config: input.config,
    configDir: input.workspace,
    cwd: input.workspace,
    sessionId: "shared",
    capabilities: ["durableTasks", "sessionBranches"],
  });
  const client = new ProtocolV2SessionClient({ sessionId: "shared", initialized, request });
  const results = [];
  for (const { method, command } of input.commands) {
    try {
      results.push(await client[method](command));
    } catch (error) {
      // 本地异常直接失败，避免序列化 undefined 后只留下空对象。
      if (!error?.data) throw error;
      results.push({
        error: error.data,
        errorInfo: ERROR_CODES[error.data.coremindCode],
        message: error.message,
      });
    }
  }
  child.stdin.end();
  let timer;
  try {
    const code = await Promise.race([
      exited,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Worker shutdown exceeded 5 seconds")), 5_000);
      }),
    ]);
    assert.equal(code, 0, stderr);
  } finally {
    clearTimeout(timer);
  }
  process.stdout.write(JSON.stringify(results));
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  if (child.exitCode === null) child.kill();
}
