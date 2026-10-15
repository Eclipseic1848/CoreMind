import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const secret = "cli-http-mcp-private-729044";
const uri = "fixture://first";

interface ModelRequest {
  messages: Array<{ role: string; content?: unknown }>;
  tools: Array<{
    function: { name: string; parameters: { properties?: { uri?: { enum?: string[] } } } };
  }>;
}

it.each([false, true])(
  "真实 CLI HTTP 资源-only（network deny=%s）首模型前零连接且保留原终态与收据",
  async (denied) => {
    expect(existsSync(cliPath), "请先构建 CLI 产物").toBe(true);
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-http-mcp-cli-"));
    const service = await startMcpHttpServer({ secret });
    const requests: ModelRequest[] = [];
    const failures: unknown[] = [];
    let readToolName = "";
    const model = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body) as ModelRequest;
          requests.push(parsed);
          const first = requests.length === 1;
          if (first) {
            expect(service.records.filter((record) => record.type === "http")).toEqual([]);
            expect(service.records.filter((record) => record.type === "socket-open")).toEqual([]);
            expect(parsed.tools).toHaveLength(3);
            const selected = parsed.tools.filter((tool) =>
              tool.function.parameters.properties?.uri?.enum?.includes(uri),
            );
            expect(selected).toHaveLength(1);
            readToolName = selected[0]!.function.name;
          } else {
            expect(requests).toHaveLength(2);
            expect(JSON.stringify(parsed.messages)).toContain("资源正文 false 0 null");
          }
          const delta = first
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "cli-http-read",
                    type: "function",
                    function: { name: readToolName, arguments: JSON.stringify({ uri }) },
                  },
                ],
              }
            : { role: "assistant", content: "HTTP 资源读取完成" };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const [content, reason] of [
            [delta, null],
            [{}, first ? "tool_calls" : "stop"],
          ]) {
            response.write(
              `data: ${JSON.stringify({ id: `cli-http-${requests.length}`, choices: [{ index: 0, delta: content, finish_reason: reason }] })}\n\n`,
            );
          }
          response.end("data: [DONE]\n\n");
        } catch (error) {
          failures.push(error);
          response.writeHead(500).end();
        }
      });
    });
    try {
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      const configFile = path.join(directory, "coremind.json");
      await writeFile(
        configFile,
        JSON.stringify({
          schemaVersion: 2,
          name: "真实 CLI HTTP MCP 资源验收",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
            model: "probe-model",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          mcp: {
            servers: {
              remote: {
                transport: "streamable-http",
                url: service.url,
                allowedAddresses: ["127.0.0.1"],
                headers: { Authorization: { env: "MCP_TEST_SECRET" } },
              },
            },
          },
          agents: { main: { mcpResources: { remote: [uri] } } },
          permissions: { mode: "full", workspaceOnly: true, network: denied ? "deny" : "allow" },
          runtime: { maxTurns: 3, maxRetries: 0, maxToolCalls: 3, runTimeoutMs: 10_000 },
        }),
        "utf8",
      );
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve, reject) => {
          execFile(
            process.execPath,
            [cliPath, "run", configFile, "--prompt", "读取已授权资源", "--json-events"],
            {
              cwd: directory,
              env: {
                ...process.env,
                COREMIND_TEST_API_KEY: "offline-test-only",
                MCP_TEST_SECRET: `Bearer ${secret}`,
              },
              encoding: "utf8",
              timeout: 20_000,
              killSignal: "SIGKILL",
              maxBuffer: 4 * 1024 * 1024,
              windowsHide: true,
            },
            (error, stdout, stderr) => {
              if (error && typeof error.code !== "number") reject(error);
              else resolve({ code: error?.code ?? 0, stdout, stderr });
            },
          );
        },
      );
      const events = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const finals = events.filter((event) => event.type === "run_result");
      expect(finals).toHaveLength(1);
      expect(events.at(-1)).toBe(finals[0]);
      expect(result.code, result.stderr).toBe(denied ? 2 : 0);
      expect(finals[0].outcome).toMatchObject(
        denied
          ? { status: "paused", finishReason: "tool_approval_denied" }
          : { status: "succeeded" },
      );
      expect(requests).toHaveLength(denied ? 1 : 2);
      expect(events.some((event) => event.type === "policy_denied")).toBe(denied);
      expect(events.some((event) => event.type === "quiescence_timeout")).toBe(false);
      const receipts = events.filter(
        (event) => event.type === "effect_receipt" && event.tool === readToolName,
      );
      expect(receipts).toContainEqual(
        expect.objectContaining({ status: denied ? "not_started" : "committed" }),
      );
      if (denied) {
        expect(
          receipts.some((event) => event.status === "started" || event.status === "unknown"),
        ).toBe(false);
        expect(service.records.filter((record) => record.type === "http")).toEqual([]);
        expect(service.records.filter((record) => record.type === "socket-open")).toEqual([]);
      } else {
        const calls = service.records.filter((record) => record.type === "request");
        expect(calls.filter((record) => record.method === "initialize")).toHaveLength(1);
        expect(calls.filter((record) => record.method === "resources/read")).toEqual([
          expect.objectContaining({ params: { uri } }),
        ]);
        expect(
          calls.some(
            (record) =>
              record.method === "tools/list" ||
              record.method === "resources/list" ||
              record.method === "resources/templates/list",
          ),
        ).toBe(false);
        const http = service.records.filter((record) => record.type === "http");
        expect(http.length).toBeGreaterThan(0);
        expect(http.every((record) => record.authorizationMatched)).toBe(true);
      }
      await vi.waitFor(() => expect(service.sockets.size).toBe(0), {
        timeout: 3_000,
        interval: 20,
      });
      expect(typeof finals[0].runStateFile).toBe("string");
      const facts = await readFile(finals[0].runStateFile, "utf8");
      const persisted = facts
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(persisted).toContainEqual(
        expect.objectContaining({
          kind: "event",
          payload: expect.objectContaining({
            event: expect.objectContaining({
              type: "effect_receipt",
              tool: readToolName,
              status: denied ? "not_started" : "committed",
            }),
          }),
        }),
      );
      expect(JSON.stringify({ events, requests, facts, stderr: result.stderr })).not.toContain(
        secret,
      );
      expect(failures).toEqual([]);
    } finally {
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      await service.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
