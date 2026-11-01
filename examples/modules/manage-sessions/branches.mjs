import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatSession, CoreMindRuntime } from "coremind-ai";

// 仅运行本地假 Provider，无真实凭据、模型服务或外部工具。
const directory = await mkdtemp(path.join(tmpdir(), "coremind-branch-example-"));
const requests = [];
const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    requests.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta: { role: "assistant", content: `回答-${requests.length}` }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ id: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const config = {
    schemaVersion: 2,
    name: "会话分支示例",
    provider: {
      id: "probe",
      model: "probe-model",
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      apiKeyEnv: "COREMIND_EXAMPLE_KEY",
    },
    agents: { main: { tools: [] } },
    session: { enabled: true, compact: false },
    runtime: { maxRetries: 0, maxTurns: 2, runTimeoutMs: 6_000 },
  };
  const open = async (sessionId) =>
    new ChatSession(
      await CoreMindRuntime.create({
        config,
        configDir: directory,
        cwd: directory,
        sessionId,
        env: { COREMIND_EXAMPLE_KEY: "test-only" },
      }),
      "main",
    );
  const chat = await open("original");
  assert.equal((await chat.chat("共同历史")).run.outcome.status, "succeeded");
  const first = await chat.inspectSessionTree();
  const at = { sessionId: first.sessionId, entryId: first.branches[0].leafId };
  await chat.chat("主线独有");
  await chat.createBranch("alternative", at);
  await chat.selectBranch("alternative");
  await chat.chat("支线独有");
  assert(!JSON.stringify(requests[2].messages).includes("主线独有"));
  const reopened = await open("original");
  const selected = await reopened.inspectSessionTree();
  assert.equal(selected.activeBranch, "alternative");
  const sourceFile = path.join(directory, "sessions", "original.jsonl");
  const before = await readFile(sourceFile, "utf8");
  const origin = {
    sessionId: selected.sessionId,
    entryId: selected.branches.find((branch) => branch.id === "alternative").leafId,
  };
  const fork = await reopened.fork(origin);
  assert.notEqual(fork.sessionId, selected.sessionId);
  assert.deepEqual(fork.forkedFrom, origin);
  const forkChat = await open(fork.sessionId);
  assert.equal((await forkChat.chat("新会话继续")).run.outcome.status, "succeeded");
  assert(!JSON.stringify(requests[3].messages).includes("主线独有"));
  assert(JSON.stringify(requests[3].messages).includes("支线独有"));
  assert.equal(await readFile(sourceFile, "utf8"), before);
  console.log("公共会话树示例通过：分支隔离、选择恢复、fork 来源与新会话对话。");
} finally {
  server.closeAllConnections();
  if (server.listening)
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
  assert.match(path.basename(directory), /^coremind-branch-example-/u);
  await rm(directory, { recursive: true, force: true });
}
