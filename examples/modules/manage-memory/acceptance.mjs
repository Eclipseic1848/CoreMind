import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const example = import.meta.dirname;
const root = path.resolve(example, "../../..");
const [question = "资料摘要应该采用哪种格式？", expected = "资料摘要优先使用表格。"] =
  process.argv.slice(2);
assert.ok(question.trim() && expected.trim(), "查询和预期记忆正文不能为空");
const auth = process.env.COREMIND_MEMORY_AUTHORIZATION;
assert.ok(auth?.startsWith("Bearer ") && auth.slice(7).trim(), "请设置记忆查询服务的 Bearer 凭据");
const fixtureKey = process.env.COREMIND_MEMORY_FIXTURE_KEY ?? "memory-local-test-only";
assert.ok(`Bearer ${fixtureKey}` !== auth, "模型夹具与记忆服务必须使用不同凭据");
const health = "http://127.0.0.1:8769/health";
assert.equal((await fetch(health, { signal: AbortSignal.timeout(5000) })).status, 401);
const ready = await fetch(health, {
  headers: { Authorization: auth },
  signal: AbortSignal.timeout(5000),
});
assert.equal(ready.status, 200);
assert.deepEqual(await ready.json(), { status: "ready" });

function writeDelta(response, delta, reason = null) {
  response.write(
    `data: ${JSON.stringify({ id: "local-memory", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
  );
}

let calls = 0;
const fixtureErrors = [];
const provider = createServer(async (request, response) => {
  try {
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.ok(request.headers.authorization === `Bearer ${fixtureKey}`, "模型夹具凭据不匹配");
    assert.ok(!body.includes(auth.slice(7)), "记忆服务凭据进入了模型请求");
    const { messages, tools } = JSON.parse(body);
    const toolMessage = messages.findLast((entry) => entry.role === "tool");
    let delta;
    if (toolMessage) {
      const content =
        typeof toolMessage.content === "string"
          ? toolMessage.content
          : toolMessage.content.map((item) => item.text).join("");
      const { memories } = JSON.parse(content);
      assert.ok(Array.isArray(memories), "记忆工具没有返回 memories 数组");
      calls += 1;
      delta = { role: "assistant", content: JSON.stringify({ memories }) };
    } else {
      assert.equal(tools.length, 1);
      const query = messages.findLast((entry) => entry.role === "user").content;
      const text = typeof query === "string" ? query : query[0].text;
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "recall",
            type: "function",
            function: { name: tools[0].function.name, arguments: JSON.stringify({ query: text }) },
          },
        ],
      };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    writeDelta(response, delta);
    writeDelta(response, {}, toolMessage ? "stop" : "tool_calls");
    response.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureErrors.push(error.message);
    response.writeHead(500).end();
  }
});

const workspace = await mkdtemp(path.join(tmpdir(), "coremind-memory-fixture-"));
try {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(8770, "127.0.0.1", resolve);
  });
  const config = path.join(workspace, "coremind.yaml");
  await copyFile(path.join(example, "coremind.yaml"), config);
  const python = process.env.COREMIND_MEMORY_PYTHON ?? "python";
  const env = {
    ...process.env,
    COREMIND_MEMORY_FIXTURE_KEY: fixtureKey,
    PYTHONPATH: path.join(root, "python/src"),
    PYTHONIOENCODING: "utf-8",
  };
  delete env.COREMIND_MEMORY_ADMIN_AUTHORIZATION;
  delete env.COREMIND_HINDSIGHT_API_KEY;
  const cli = path.join(root, "packages/coremind-cli/dist/cli.js");
  const pythonArgs = ["-B", "-X", "utf8", path.join(example, "search.py"), config, question];
  const fixtures = [
    ["CLI + YAML", process.execPath, [cli, "run", config, "--prompt", question, "--json-events"]],
    ["TypeScript SDK", process.execPath, [path.join(example, "search.mjs"), config, question]],
    ["Python SDK", python, pythonArgs],
    ["Python Async SDK", python, [...pythonArgs, "--async"]],
  ];
  let reference;
  for (const [entry, command, args] of fixtures) {
    let output;
    try {
      output = await exec(command, args, { cwd: workspace, env, encoding: "utf8", timeout: 30000 });
    } catch (error) {
      const finalEvent = entry === "CLI + YAML" && error.stdout?.trim().split("\n").at(-1);
      throw new Error(
        `${entry} 执行失败：${error.stderr || error.message}\n${finalEvent || ""}\n${fixtureErrors.join("\n")}`,
        { cause: error },
      );
    }
    const body =
      entry === "CLI + YAML"
        ? output.stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((event) => event.type === "text_delta")
            .map((event) => event.delta)
            .join("")
        : output.stdout.trim();
    const { memories } = JSON.parse(body);
    const hit = memories.find(({ text }) => text.includes(expected));
    assert.ok(hit, `${entry} 未召回预期记忆`);
    const { documentId, version, source, bankId } = hit;
    assert.ok(typeof documentId === "string" && documentId.trim(), `${entry} 缺少文档标识`);
    assert.ok(Number.isInteger(version) && version > 0, `${entry} 缺少版本`);
    assert.ok(typeof bankId === "string" && bankId.trim(), `${entry} 缺少记忆库标识`);
    assert.ok(
      typeof source === "string" ? source.trim() : source && Object.keys(source).length,
      `${entry} 缺少来源`,
    );
    const evidence = { documentId, version, source, bankId, text: hit.text };
    if (reference) assert.deepEqual(evidence, reference, entry);
    reference = evidence;
    console.log(JSON.stringify({ entry, memories: memories.length, verified: evidence }));
  }
  assert.equal(calls, fixtures.length);
} finally {
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
