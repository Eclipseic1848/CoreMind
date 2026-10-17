import { type ExecFileException, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const host = fileURLToPath(new URL("./vendor/windows-mcp/host.exe", import.meta.url));
const guard = fileURLToPath(new URL("./vendor/windows-mcp/guard.dll", import.meta.url));

describe.skipIf(process.platform !== "win32")("Windows MCP 固定启动器拒绝无效程序集", () => {
  it.each(["guard-hash", "assembly-load"] as const)("%s 静默退出且未连接 owner", async (mode) => {
    const temporary = await mkdtemp(path.join(tmpdir(), "coremind-mcp-host-"));
    const ownerName = `coremind-mcp-owner-${randomUUID()}`;
    let ownerConnected = false;
    const server = createServer((socket) => {
      ownerConnected = true;
      socket.on("error", () => {});
      // 若回归导致误放行，只发送取消，不创建业务 Job。
      socket.end('{"cancel":true}\n');
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(`\\\\.\\pipe\\${ownerName}`, resolve);
      });
      const invalidAssembly = path.join(temporary, "invalid.dll");
      const bytes =
        mode === "guard-hash" ? await readFile(guard) : Buffer.from("invalid assembly", "utf8");
      if (mode === "assembly-load") await writeFile(invalidAssembly, bytes);
      const env: NodeJS.ProcessEnv = {};
      for (const name of ["SystemRoot", "windir", "TEMP", "TMP"]) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      env.COREMIND_MCP_OWNER_PIPE = ownerName;
      env.COREMIND_MCP_GUARD_ASSEMBLY = mode === "guard-hash" ? guard : invalidAssembly;
      env.COREMIND_MCP_GUARD_SHA256 =
        mode === "guard-hash" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
      const result = await new Promise<{
        error: ExecFileException | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        execFile(
          host,
          [],
          { env, windowsHide: true, encoding: "utf8", timeout: 5_000 },
          (error, stdout, stderr) => resolve({ error, stdout, stderr }),
        );
      });
      expect(result.error?.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(ownerConnected).toBe(false);
    } finally {
      if (server.listening)
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      expect(path.dirname(temporary)).toBe(path.resolve(tmpdir()));
      expect(path.basename(temporary)).toMatch(/^coremind-mcp-host-/u);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
