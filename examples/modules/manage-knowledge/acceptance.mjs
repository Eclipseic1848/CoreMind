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
const question = "现行的普通咨询要从哪个栏目递交？";
const auth = process.env.COREMIND_KNOWLEDGE_AUTHORIZATION;
assert.ok(auth, "请设置本地知识服务的 Authorization 环境变量");

const health = "http://127.0.0.1:8767/health";
assert.equal((await fetch(health, { signal: AbortSignal.timeout(5000) })).status, 401);
const ready = await fetch(health, {
  headers: { Authorization: auth },
  signal: AbortSignal.timeout(5000),
});
assert.equal(ready.status, 200);
assert.deepEqual(await ready.json(), { status: "ready" });

function writeDelta(response, delta, reason = null) {
  response.write(
    `data: ${JSON.stringify({ id: "local-knowledge", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
  );
}

let calls = 0;
const fixtureErrors = [];
const provider = createServer(async (request, response) => {
  try {
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.equal(request.url, "/v1/chat/completions");
    const { messages, tools } = JSON.parse(body);
    assert.ok(!body.includes(auth), "工具凭据不能进入模型请求");
    const toolMessage = messages.findLast((entry) => entry.role === "tool");
    let delta;
    if (toolMessage) {
      const content =
        typeof toolMessage.content === "string"
          ? toolMessage.content
          : toolMessage.content.map((item) => item.text).join("");
      const { citations } = JSON.parse(content);
      assert.ok(Array.isArray(citations));
      calls += 1;
      delta = { role: "assistant", content: JSON.stringify({ citations }) };
    } else {
      assert.equal(tools.length, 1);
      const query = messages.findLast((entry) => entry.role === "user").content;
      const text = typeof query === "string" ? query : query[0].text;
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "lookup",
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

const workspace = await mkdtemp(path.join(tmpdir(), "coremind-knowledge-fixture-"));
try {
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(8768, "127.0.0.1", resolve);
  });
  const config = path.join(workspace, "coremind.yaml");
  await copyFile(path.join(example, "coremind.yaml"), config);
  const python = process.env.COREMIND_KNOWLEDGE_PYTHON ?? "python";
  const env = {
    ...process.env,
    COREMIND_KNOWLEDGE_FIXTURE_KEY: "local-test-only",
    PYTHONPATH: path.join(root, "python/src"),
    PYTHONIOENCODING: "utf-8",
  };
  const cli = path.join(root, "packages/coremind-cli/dist/cli.js");
  const fixtures = [
    ["CLI + YAML", process.execPath, [cli, "run", config, "--prompt", question, "--json-events"]],
    ["TypeScript SDK", process.execPath, [path.join(example, "search.mjs"), config, question]],
    ["Python SDK", python, ["-B", "-X", "utf8", path.join(example, "search.py"), config, question]],
    [
      "Python Async SDK",
      python,
      ["-B", "-X", "utf8", path.join(example, "search.py"), config, question, "--async"],
    ],
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
    const result = JSON.parse(body);
    const hit = result.citations.find(
      ({ docId, version, file, line }) =>
        docId === "资料室手册" && version === 2 && file === "资料室手册-v2.md" && line === 5,
    );
    assert.ok(hit?.text.includes("“读者来信”栏提交"), JSON.stringify(result));
    if (reference) assert.deepEqual(result, reference, entry);
    reference = result;
    console.log(JSON.stringify({ entry, citations: result.citations.length, verified: hit }));
  }
  assert.equal(calls, fixtures.length);
} finally {
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
