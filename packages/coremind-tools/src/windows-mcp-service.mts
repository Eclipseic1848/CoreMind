import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { execa } from "execa";

const MAX_CONTROL_BYTES = 1024 * 1024;
const name = process.env.COREMIND_MCP_SERVICE_PIPE;
if (
  !name ||
  !/^coremind-mcp-service-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(name)
)
  process.exit(1);
const socket = createConnection(`\\\\.\\pipe\\${name}`);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let pending = Buffer.alloc(0);
let configured = false;
let ending = false;
function finish(type: "exit" | "error", code: number): void {
  if (ending) return;
  ending = true;
  if (socket.destroyed) process.exit(code);
  socket.end(`${JSON.stringify({ type })}\n`, () => process.exit(code));
}
const failure = () => finish("error", 1);
socket.on("error", () => process.exit(1));
socket.on("end", () => {
  if (!ending) process.exit(1);
});
socket.on("close", () => {
  if (!ending) process.exit(1);
});
process.on("uncaughtException", failure);
process.on("unhandledRejection", failure);
socket.on("data", async (chunk: Buffer) => {
  try {
    if (configured || pending.length + chunk.length > MAX_CONTROL_BYTES) throw new Error();
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(10);
    if (end < 0) return;
    if (end !== pending.length - 1) throw new Error();
    const value: unknown = JSON.parse(decoder.decode(pending.subarray(0, end)));
    pending = Buffer.alloc(0);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const config = value as { command?: unknown; args?: unknown; cwd?: unknown; env?: unknown };
    if (
      Object.keys(value).some((key) => !["command", "args", "cwd", "env"].includes(key)) ||
      typeof config.command !== "string" ||
      !config.command ||
      config.command.includes("\0") ||
      !Array.isArray(config.args) ||
      config.args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
      typeof config.cwd !== "string" ||
      config.cwd.includes("\0") ||
      !config.env ||
      typeof config.env !== "object" ||
      Array.isArray(config.env)
    )
      throw new Error();
    const env: Record<string, string> = Object.create(null);
    const keys = new Set<string>();
    for (const [key, value] of Object.entries(config.env)) {
      if (
        key.includes("\0") ||
        keys.has(key.toUpperCase()) ||
        typeof value !== "string" ||
        value.includes("\0")
      )
        throw new Error();
      keys.add(key.toUpperCase());
      env[key] = value;
    }
    configured = true;
    // Execa 对缺失文件也可能先启动 cmd；固定绝对目标须先存在，不能把包装进程当服务就绪。
    if (path.win32.isAbsolute(config.command) && !(await stat(config.command)).isFile())
      throw new Error();
    if (ending || socket.destroyed || socket.readableEnded) return;
    // Execa 继续拥有 Windows cmd、shebang、参数引用及隔离环境语义；Job 持有整树。
    const subprocess = execa(config.command, config.args as string[], {
      cwd: config.cwd,
      env,
      extendEnv: false,
      shell: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      reject: false,
      windowsHide: true,
      cleanup: false,
      killDescendants: false,
    });
    let spawned = false;
    subprocess.nodeChildProcess.once("spawn", () => {
      if (ending || socket.destroyed) return;
      spawned = true;
      socket.write(`${JSON.stringify({ type: "ready" })}\n`, (error) => {
        if (error) failure();
      });
    });
    void subprocess.then(() => finish(spawned ? "exit" : "error", spawned ? 0 : 1), failure);
  } catch {
    failure();
  }
});
