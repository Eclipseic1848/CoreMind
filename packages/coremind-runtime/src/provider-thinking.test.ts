import "../../../test/setup-env.js";
import { mkdtempSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateConfig } from "coremind-config";
import { describe, expect, it } from "vitest";
import { CoreMindRuntime } from "./runtime.js";

describe("自定义 Provider 的 Qwen 思考控制", () => {
  it.each([
    ["qwen", "off", false],
    ["qwen", "high", true],
    ["qwen-chat-template", "off", false],
    ["qwen-chat-template", "high", true],
    [undefined, "off", false],
  ] as const)("通过公开 Runtime 发送 %s / %s 的思考开关", async (format, level, enabled) => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push(JSON.parse(body) as Record<string, unknown>);
        sendSse(response, [
          {
            id: "qwen-thinking-off",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "完成" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "qwen-thinking-off",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ]);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const port = (server.address() as AddressInfo).port;
      const provider = {
        id: "bailian-probe",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "qwen3.8-27b",
        apiKeyEnv: "COREMIND_TEST_API_KEY",
        ...(format ? { thinkingFormat: format } : {}),
      } as const;
      const config = validateConfig({
        schemaVersion: 2,
        name: "Qwen 思考关闭测试",
        provider,
        agents: {
          main: {
            systemPrompt: "直接回答",
            options: { thinkingLevel: level, maxTokens: 900 },
          },
        },
        defaultAgent: "main",
      });
      const dir = mkdtempSync(path.join(tmpdir(), "coremind-qwen-thinking-off-"));
      const runtime = await CoreMindRuntime.create({
        config,
        configDir: dir,
        cwd: dir,
        initialPrompt: "回复完成",
      });

      const result = await runtime.run();

      expect(result.outcome.status).toBe("succeeded");
      expect(requests).toHaveLength(1);
      const body = requests[0]!;
      expect(body.model).toBe(provider.model);
      expect(body.max_completion_tokens ?? body.max_tokens).toBe(900);
      if (format === "qwen") {
        expect(body.enable_thinking).toBe(enabled);
        expect(body.chat_template_kwargs).toBeUndefined();
      } else if (format === "qwen-chat-template") {
        expect(body.chat_template_kwargs).toEqual({
          enable_thinking: enabled,
          preserve_thinking: true,
        });
        expect(body.enable_thinking).toBeUndefined();
      } else {
        expect(body.chat_template_kwargs).toBeUndefined();
        expect(body.enable_thinking).toBeUndefined();
      }
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    [{ thinkingFormat: "unsupported" }, /provider\.thinkingFormat/],
    [{ requestBody: { Authorization: "不得透传" } }, /provider\.requestBody/],
  ])("配置验证拒绝无效格式或任意请求体", (extra, error) => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        name: "受限请求配置",
        provider: { id: "endpoint", model: "qwen", baseUrl: "http://127.0.0.1/v1", ...extra },
        agents: { main: {} },
      }),
    ).toThrowError(error);
  });
});

function sendSse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
