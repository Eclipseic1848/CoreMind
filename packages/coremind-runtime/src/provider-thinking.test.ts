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
  it("通过公开 Runtime seam 关闭思考，且拒绝任意请求体透传", async () => {
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
        thinkingFormat: "qwen",
      } as const;
      const config = validateConfig({
        schemaVersion: 2,
        name: "Qwen 思考关闭测试",
        provider,
        agents: {
          main: {
            systemPrompt: "直接回答",
            options: { thinkingLevel: "off" },
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
      expect(requests[0]).toMatchObject({
        model: "qwen3.8-27b",
        enable_thinking: false,
      });
      expect(() =>
        validateConfig({
          schemaVersion: 2,
          name: "禁止任意请求体",
          provider: {
            ...provider,
            requestBody: { Authorization: "不得透传" },
          },
          agents: { main: { systemPrompt: "测试" } },
        }),
      ).toThrowError(/provider\.requestBody/);
    } finally {
      await closeServer(server);
    }
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
