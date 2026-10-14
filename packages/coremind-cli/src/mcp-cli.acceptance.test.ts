import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const servicePath = fileURLToPath(
  new URL("../../../test/fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const secret = "cli-mcp-private-value-729043";
const businessArgs = { value: { flag: false, count: 0, empty: null } };
const inputSchema = {
  type: "object",
  $defs: { value: {} },
  properties: { value: { $ref: "#/$defs/value" } },
  required: ["value"],
  additionalProperties: false,
};

interface WireRequest {
  messages: Array<{ role: string; content?: unknown }>;
  tools: Array<{ function: { name: string; parameters: unknown } }>;
}

interface ServiceRecord {
  type?: string;
  method?: string;
  pid?: number;
  childPid?: number;
  params?: unknown;
}

it.each([false, true])(
  "真实 CLI 本地服务（workspaceOnly=%s）遵守准入并回收进程树",
  async (restricted) => {
    expect(existsSync(cliPath), "请先构建 CLI 产物").toBe(true);
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-mcp-cli-"));
    const recordFile = path.join(directory, "service.jsonl");
    const requests: WireRequest[] = [];
    const failures: unknown[] = [];
    let child: ChildProcess | undefined;
    let closed: Promise<void> | undefined;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body) as WireRequest;
          requests.push(parsed);
          const calling = requests.length === 1;
          const delta = calling
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "cli-mcp-call",
                    type: "function",
                    function: {
                      name: parsed.tools[0]!.function.name,
                      arguments: JSON.stringify(businessArgs),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "本地服务执行完成" };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const [content, reason] of [
            [delta, null],
            [{}, calling ? "tool_calls" : "stop"],
          ]) {
            response.write(
              `data: ${JSON.stringify({ id: `cli-mcp-${requests.length}`, choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
            );
          }
          response.end("data: [DONE]\n\n");
        } catch (error) {
          failures.push(error);
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "本地模型夹具失败" } }));
        }
      });
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const configFile = path.join(directory, "coremind.json");
      await writeFile(
        configFile,
        JSON.stringify({
          schemaVersion: 2,
          name: "真实 CLI 本地服务验收",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          mcp: {
            servers: {
              local: {
                transport: "stdio",
                command: process.execPath,
                args: [servicePath, recordFile],
                cwd: directory,
                env: { MCP_TEST_SECRET: { env: "MCP_TEST_SECRET" } },
              },
            },
          },
          agents: {
            main: {
              tools: [
                {
                  mcp: { server: "local", tool: "echo" },
                  effect: { operations: ["external"], reversible: false },
                  capability: {
                    effect: "external",
                    replay: "unknown",
                    concurrency: "run_serial",
                    checkpoint: "unsupported",
                    durability: "critical",
                  },
                },
              ],
            },
          },
          permissions: { mode: "full", workspaceOnly: restricted, network: "allow" },
          runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 3, runTimeoutMs: 10_000 },
        }),
        "utf8",
      );
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          child = spawn(
            process.execPath,
            [cliPath, "run", configFile, "--prompt", "调用本地回声工具", "--json-events"],
            {
              cwd: directory,
              env: {
                ...process.env,
                COREMIND_TEST_API_KEY: "offline-test-only",
                MCP_TEST_SECRET: secret,
                COREMIND_MCP_UNLISTED: "host-only",
              },
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: true,
              signal: AbortSignal.timeout(12_000),
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout!.setEncoding("utf8");
          child.stderr!.setEncoding("utf8");
          child.stdout!.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr!.on("data", (chunk: string) => {
            stderr += chunk;
          });
          child.once("error", reject);
          closed = new Promise<void>((accept) => child!.once("close", () => accept()));
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        },
      );
      expect(result.stdout).not.toContain(secret);
      expect(result.stderr).not.toContain(secret);
      const events = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const finals = events.filter((event) => event.type === "run_result");
      expect(finals).toHaveLength(1);
      expect(events.at(-1)).toBe(finals[0]);
      expect(events.some((event) => event.type === "quiescence_timeout")).toBe(false);
      const records = await serviceRecords(recordFile);
      if (restricted) {
        expect(result.code, result.stderr).toBe(2);
        expect(finals[0]).toMatchObject({
          outcome: { status: "paused", finishReason: "tool_approval_denied" },
        });
        expect(events.some((event) => event.type === "policy_denied")).toBe(true);
        expect(existsSync(recordFile)).toBe(false);
        expect(requests).toEqual([]);
      } else {
        expect(result.code, result.stderr).toBe(0);
        expect(finals[0]).toMatchObject({
          outcome: { status: "succeeded" },
          metrics: { toolCalls: 3 },
        });
        expect(requests).toHaveLength(2);
        expect(requests[0]!.tools).toHaveLength(1);
        expect(requests[0]!.tools[0]!.function.parameters).toEqual(inputSchema);
        const name = requests[0]!.tools[0]!.function.name;
        expect(name).toMatch(/^mcp_[A-Za-z0-9_-]+$/u);
        expect(
          events.filter((event) => event.type === "tool_call").map((event) => event.tool),
        ).toEqual([
          expect.stringMatching(/^mcp_connect_/u),
          expect.stringMatching(/^mcp_list_/u),
          name,
        ]);
        expect(records.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(records.filter((record) => record.method === "tools/list")).toHaveLength(2);
        const calls = records.filter((record) => record.method === "tools/call");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.params).toEqual({ name: "echo", arguments: businessArgs });
        expect(records).toContainEqual({ type: "environment", allowed: true, forbidden: false });
        const started = records.find((record) => record.type === "started")!;
        expect(started).toMatchObject({ pid: expect.any(Number), childPid: expect.any(Number) });
        expect(records).toContainEqual({ type: "child-ready", pid: started.childPid });
        await vi.waitFor(
          () => {
            expect(alive(started.pid!)).toBe(false);
            expect(alive(started.childPid!)).toBe(false);
          },
          { timeout: 3_000, interval: 20 },
        );
        expect(JSON.stringify(requests)).not.toContain(secret);
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        failures.push(new Error("真实 CLI 未正常退出"));
        child.kill("SIGKILL");
      }
      await closed;
      const started = (await serviceRecords(recordFile)).find(
        (record) => record.type === "started",
      );
      if (started) {
        for (const pid of [started.childPid!, started.pid!]) {
          if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
            throw new Error("夹具自有 PID 无效");
          if (!alive(pid)) continue;
          // 先留下产品清理失败，再兜底本格 PID；不能用测试清理冒充正常退出。
          failures.push(new Error("CLI 退出后本地服务进程仍存活"));
          if (process.platform === "win32")
            spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
          else process.kill(pid, "SIGKILL");
        }
      }
    } catch (error) {
      failures.push(error);
    }
    try {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "真实 CLI 本地服务主流程与资源清理");
  },
);

async function serviceRecords(file: string): Promise<ServiceRecord[]> {
  return existsSync(file)
    ? (await readFile(file, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ServiceRecord)
    : [];
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
