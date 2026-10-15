import "../../../test/setup-env.js";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { expect, it, vi } from "vitest";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";
import type { CoreMindEvent } from "./events.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";

const content = `artifact-head-739027\n${"p".repeat(24 * 1024)}\nartifact-tail-846032`;
type ArtifactEvent = Extract<CoreMindEvent, { type: "artifact_created" }> & {
  agent?: string;
  stepId?: string;
};
type Request = {
  messages: Array<{ role: string; content?: unknown }>;
  tools?: Array<{ function: { name: string } }>;
};

it.each(["batch", "workflow"] as const)(
  "%s 真实 MCP 大输出产生受控 Artifact 并保留完整调用来源",
  async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-artifact-identity-"));
    const service = await startMcpHttpServer();
    const requests: Request[] = [];
    const failures: unknown[] = [];
    const aliases = new Set<string>();
    let runtime: CoreMindRuntime | undefined;
    let running: Promise<RunResult> | undefined;
    const model = createServer((request, response) => {
      let text = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        text += chunk;
      });
      request.on("end", () => {
        try {
          const body = JSON.parse(text) as Request;
          requests.push(body);
          const finished = body.messages.some((message) => message.role === "tool");
          if (finished) {
            // 使用真正的 ManagedClient 超限产物，不伪造 fullOutputPath 或更改阈值。
            expect(JSON.stringify(body.messages)).toContain("Artifact: .coremind/artifacts/");
            send(response, { role: "assistant", content: "大输出验收完成" }, "stop");
            return;
          }
          expect(body.tools).toHaveLength(1);
          const name = body.tools![0]!.function.name;
          aliases.add(name);
          const ids = mode === "batch" ? ["call-left", "call-right"] : ["same-call"];
          send(
            response,
            {
              role: "assistant",
              tool_calls: ids.map((id, index) => ({
                index,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify({ value: content }) },
              })),
            },
            "tool_calls",
          );
        } catch (error) {
          failures.push(error);
          if (!response.headersSent) response.writeHead(500);
          response.end();
        }
      });
    });
    try {
      await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
      const selected = {
        mcp: { server: "remote", tool: "echo" },
        effect: { operations: ["network" as const], reversible: false },
        // 唯一夹具的 echo 只回显参数，完整显式授权其并发能力，不修改生产执行通道。
        capability: {
          effect: "network" as const,
          replay: "unknown" as const,
          concurrency: "parallel" as const,
          checkpoint: "none" as const,
          durability: "critical" as const,
        },
      };
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "Artifact 来源身份验收",
        provider: {
          id: "artifact-probe",
          model: "probe",
          apiKeyEnv: "COREMIND_TEST_API_KEY",
          baseUrl: `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`,
        },
        mcp: {
          servers: {
            remote: {
              transport: "streamable-http",
              url: service.url,
              allowedAddresses: ["127.0.0.1"],
            },
          },
        },
        agents: {
          main: { tools: [selected] },
          ...(mode === "workflow" ? { peer: { tools: [selected] } } : {}),
        },
        permissions: { mode: "ask", workspaceOnly: true, network: "allow" },
        runtime: { maxTurns: 8, maxToolCalls: 10, maxRetries: 0, runTimeoutMs: 10_000 },
        ...(mode === "workflow"
          ? {
              workflow: [
                {
                  id: "parallel",
                  type: "parallel" as const,
                  steps: [
                    { id: "a", type: "prompt" as const, agent: "main", input: "a" },
                    { id: "b", type: "prompt" as const, agent: "peer", input: "b" },
                  ],
                },
              ],
            }
          : {}),
      };
      runtime = await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        initialPrompt: "调用已授权工具产生大输出",
        approveTool: async () => "allow",
      });
      running = runtime.run();
      const result = await running;
      expect(result.outcome.status, JSON.stringify(result.outcome)).toBe("succeeded");
      expect(failures).toEqual([]);
      expect(requests).toHaveLength(mode === "batch" ? 2 : 4);
      expect(
        service.records.filter(
          (record) => record.type === "request" && record.method === "tools/call",
        ),
      ).toHaveLength(2);
      const records = result.artifacts ?? [];
      const events = result.trace.map((entry) => entry.event);
      const artifacts = events.filter(
        (event): event is ArtifactEvent => event.type === "artifact_created",
      );
      const calls = events.filter(
        (event): event is Extract<CoreMindEvent, { type: "tool_call" }> =>
          event.type === "tool_call" && aliases.has(event.tool),
      );
      expect(records).toHaveLength(2);
      expect(artifacts).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(new Set(records.map((record) => record.artifactId)).size).toBe(2);
      for (const record of records) {
        expect(record.status).toBe("stored");
        expect(record.relativePath).toMatch(/^\.coremind\/artifacts\/[A-Za-z0-9_-]+\.log$/);
        const bytes = await readFile(path.join(directory, record.relativePath!));
        expect(bytes.byteLength).toBe(record.sizeBytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
        const stored = JSON.parse(bytes.toString("utf8")) as {
          mcp: { content: Array<{ text: string }>; structuredContent: { result: string } };
        };
        expect(JSON.parse(stored.mcp.content[0]!.text)).toBe(content);
        expect(stored.mcp.structuredContent.result).toBe(content);
        expect(artifacts.find((event) => event.artifactId === record.artifactId)).toMatchObject({
          status: "stored",
          relativePath: record.relativePath,
          sizeBytes: record.sizeBytes,
          sha256: record.sha256,
        });
      }
      // 两个分支使用相同原始 callId；必须同时保留真实 Agent 与 Step，不能按出现次序猜。
      const sources = (
        items: Array<{ agent?: string; stepId?: string; callId?: string; tool: string }>,
      ) =>
        items
          .map(({ agent, stepId, callId, tool }) => ({ agent, stepId, callId, tool }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
      expect(sources(artifacts)).toEqual(sources(calls));
      if (mode === "batch") {
        expect(calls.map((call) => call.callId).sort()).toEqual(["call-left", "call-right"]);
        expect(artifacts.every((event) => !Object.hasOwn(event, "stepId"))).toBe(true);
      } else {
        expect(calls.map((call) => call.callId)).toEqual(["same-call", "same-call"]);
        expect(calls.map((call) => [call.agent, call.stepId]).sort()).toEqual([
          ["main", "a"],
          ["peer", "b"],
        ]);
      }
      expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => expect(service.sockets.size).toBe(0));
    } finally {
      if (running) await running;
      if (runtime) expect(await runtime.waitForQuiescence()).toBe(true);
      await vi.waitFor(() => expect(service.sockets.size).toBe(0));
      await service.close();
      model.closeAllConnections();
      if (model.listening) await new Promise<void>((resolve) => model.close(() => resolve()));
      await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  },
);

function send(response: ServerResponse, delta: object, reason: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [change, finish] of [
    [delta, null],
    [{}, reason],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "artifact-identity", choices: [{ index: 0, delta: change, finish_reason: finish }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
