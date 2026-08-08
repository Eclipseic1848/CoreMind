import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { ChatSession } from "./chat-session.js";
import { CoreMindRuntime } from "./runtime.js";

describe("ChatSession", () => {
  it("模型执行失败时向调用方报告失败", async () => {
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "对话失败测试",
      provider: {
        id: "probe",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "probe-model",
        apiKey: "test-key",
      },
      agents: { main: { systemPrompt: "测试助手" } },
    };
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: mkdtempSync(path.join(tmpdir(), "coremind-chat-failure-")),
    });
    const chat = new ChatSession(runtime, "main");

    await expect(chat.chat("触发模型错误")).rejects.toMatchObject({ code: "agent_failed" });
  });

  it("每轮只返回本轮新增的 assistant 文本", async () => {
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const text = body.includes("第二问") ? "第二轮回答" : "第一轮回答";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chat",
            choices: [
              { index: 0, delta: { role: "assistant", content: text }, finish_reason: null },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "chat",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const config: CoreMindConfig = {
        schemaVersion: 2,
        name: "多轮结果测试",
        provider: {
          id: "probe",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "probe-model",
          apiKey: "test-key",
        },
        agents: { main: { systemPrompt: "测试助手" } },
      };
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: mkdtempSync(path.join(tmpdir(), "coremind-chat-session-")),
      });
      const chat = new ChatSession(runtime, "main");

      const first = await chat.chat("第一问");
      const second = await chat.chat("第二问");

      expect(first.text).toBe("第一轮回答");
      expect(second.text).toBe("第二轮回答");
      expect(first.run.outcome.status).toBe("succeeded");
      expect(first.run.metrics.turns).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("每轮对话经过权限审批、预算、Trace 和 checkpoint Harness", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-chat-harness-"));
    writeFileSync(path.join(dir, "notes.txt"), "审批测试", "utf8");
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const messages =
          (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages ?? [];
        if (messages.some((message) => message.role === "tool")) {
          sendSse(response, [
            {
              id: "final",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "读取完成" },
                  finish_reason: null,
                },
              ],
            },
            { id: "final", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ]);
          return;
        }
        sendSse(response, [
          {
            id: "tool",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "chat-call-read",
                      type: "function",
                      function: { name: "read", arguments: '{"path":"notes.txt"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { id: "tool", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const approvals: string[] = [];

    try {
      const port = (server.address() as AddressInfo).port;
      const runtime = await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "对话 Harness 测试",
          provider: {
            id: "probe",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            model: "probe-model",
            apiKey: "test-key",
          },
          tools: [{ id: "read" }],
          agents: { main: { systemPrompt: "按要求调用工具" } },
          permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
        },
        configDir: dir,
        cwd: dir,
        approveTool: async (request) => {
          approvals.push(request.tool);
          return "allow";
        },
      });
      const result = await new ChatSession(runtime, "main").chat("读取 notes.txt");

      expect(approvals).toEqual(["read"]);
      expect(result.run.metrics.toolCalls).toBe(1);
      expect(result.run.trace.some((entry) => entry.event.type === "approval_required")).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}
