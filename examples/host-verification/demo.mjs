import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { CoreMindRuntime } from "coremind-ai";

// 仅用 localhost 模型替身演示握手；不连接真实 Provider。
const directory = await mkdtemp(path.join(tmpdir(), "coremind-host-demo-"));
const candidates = ["draft", "revised"];
let modelCalls = 0;
const server = createServer((_request, response) => {
  const candidate = candidates[modelCalls++];
  if (candidate === undefined) {
    response.writeHead(500).end("unexpected model request");
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    { index: 0, delta: { role: "assistant", content: candidate }, finish_reason: null },
    { index: 0, delta: {}, finish_reason: "stop" },
  ])
    response.write(`data: ${JSON.stringify({ id: "offline-demo", choices: [choice] })}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const replies = [];
const requests = [];
try {
  const runtime = await CoreMindRuntime.create({
    config: {
      schemaVersion: 2,
      name: "宿主独立验收示例",
      provider: {
        id: "offline-demo",
        model: "offline-demo",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        apiKeyEnv: "COREMIND_OFFLINE_DEMO_KEY",
      },
      agents: { worker: { systemPrompt: "按请求生成候选" } },
      loop: {
        execute: { agent: "worker", input: "{{prompt}}" },
        verify: { mode: "host", timeoutMs: 5_000 },
        repair: { agent: "worker", input: "按宿主反馈修正：{{verification.text}}" },
        maxIterations: 2,
        maxRepairs: 1,
      },
    },
    env: { COREMIND_OFFLINE_DEMO_KEY: "offline-only" },
    configDir: directory,
    cwd: directory,
    initialPrompt: "生成示例结果",
    onVerification: (request) => {
      requests.push(request);
      assert.equal(
        createHash("sha256").update(request.candidate, "utf8").digest("hex"),
        request.candidateSha256,
      );
      const accepted = request.candidate === "revised";
      replies.push(
        runtime.acceptControl({
          schemaVersion: 1,
          controlId: `reply-${request.requestId}`,
          runId: request.runId,
          type: "verification",
          requestId: request.requestId,
          candidateSha256: request.candidateSha256,
          decision: accepted ? "accept" : "reject",
          feedback: accepted ? "" : "请修正草稿",
        }),
      );
    },
  });
  const result = await runtime.run();
  await Promise.all(replies);
  assert.equal(result.outcome.status, "succeeded");
  assert.equal(result.transcript, "revised");
  assert.equal(modelCalls, 2);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.runId === result.runId));
  console.log(
    JSON.stringify({
      runId: result.runId,
      status: result.outcome.status,
      modelCalls,
      verifications: requests.length,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
