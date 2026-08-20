import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

/**
 * CLI SIGINT 取消（规格 04 门 C 验收 AC-2：四入口取消路径之一）。
 * run 进行中（mock 延迟响应）发 SIGINT → CLI 的 process.once("SIGINT") → controller.abort()
 * → run 以 aborted 终态结束；迟到的流式文本不出现在 stdout（方案 A）。
 */
describe("CLI SIGINT 取消", () => {
  it("run 进行中收到 SIGINT：aborted 终态、无迟到输出", async () => {
    let requestCount = 0;
    const server = createServer((request, response) => {
      request.resume(); // 排空请求体（响应不需要解析 body）
      request.on("end", () => {
        requestCount += 1;
        // 延迟 400ms 响应：确保 SIGINT 在流式进行中到达
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          response.write(
            `data: ${JSON.stringify({
              id: "a",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "迟到的完整回答" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ id: "a", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: "usage",
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        }, 400);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-sigint-"));
    writeFileSync(
      path.join(dir, "coremind.yaml"),
      `schemaVersion: 2
name: SIGINT 测试
provider:
  id: probe
  baseUrl: http://127.0.0.1:${port}/v1
  model: probe-model
  apiKey: test-key
agents:
  main:
    systemPrompt: 助手
`,
      "utf8",
    );
    try {
      const child = spawn(
        "node",
        [cliPath, "run", path.join(dir, "coremind.yaml"), "--prompt", "请回答", "--print"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      // 等 mock 收到请求（run 已在执行）再发 SIGINT
      const deadline = Date.now() + 5_000;
      while (requestCount === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(requestCount).toBe(1);
      child.kill("SIGINT");
      const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        let stdout = "";
        child.stdout?.on("data", (data: Buffer) => {
          stdout += data.toString("utf8");
        });
        child.on("close", (code) => resolve({ code, stdout }));
      });
      // 迟到文本不入 stdout（方案 A：竞态赢家文本丢弃）
      expect(result.stdout).not.toContain("迟到的完整回答");
      // SIGINT 中止是非正常退出（非 0）
      expect(result.code).not.toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
