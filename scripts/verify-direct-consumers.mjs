import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const [tsProject, pyProject, python, privateFile] = process.argv.slice(2);
assert(
  tsProject && pyProject && python && privateFile,
  "用法：node scripts/verify-direct-consumers.mjs <TS 项目> <Python 项目> <Python 解释器> <服务配置 JSON>",
);
const { knowledge, memory } = JSON.parse(await readFile(privateFile, "utf8"));
const checkout = await realpath(new URL("..", import.meta.url));
const projects = await Promise.all([realpath(tsProject), realpath(pyProject)]);
assert.notEqual(projects[0], projects[1], "请使用两个独立项目");
for (const project of projects) {
  const location = relative(checkout, project);
  assert.ok(isAbsolute(location) || location.startsWith(`..${sep}`), "消费者项目应在仓库外");
}
const domains = [
  {
    ...knowledge,
    id: "knowledge",
    cwd: tsProject,
    executable: process.execPath,
    urlKey: "KNOWLEDGE_MCP_URL",
    tokenKey: "COREMIND_KNOWLEDGE_AUTHORIZATION",
    field: "citations",
    direct: ["direct.mts"],
    agent: ["agent.mts"],
    removed: ["agent.mts", "--without-knowledge"],
    tools: ["search_knowledge", "resolve_citation"],
  },
  {
    ...memory,
    id: "memory",
    cwd: pyProject,
    executable: resolve(python),
    urlKey: "COREMIND_MEMORY_MCP_URL",
    tokenKey: "COREMIND_MEMORY_AUTHORIZATION",
    field: "memories",
    direct: ["-X", "utf8", "app.py", "direct"],
    agent: ["-X", "utf8", "app.py", "agent"],
    removed: ["-X", "utf8", "app.py", "runtime-only"],
    tools: ["recall_memory"],
  },
];
const secrets = domains.flatMap(({ authorization, other }) => [authorization, other.authorization]);
for (const domain of domains) {
  for (const endpoint of [domain, domain.other]) {
    const url = new URL(endpoint.url);
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(typeof endpoint.authorization, "string");
    assert.ok(endpoint.authorization.startsWith("Bearer "));
  }
  assert.equal(typeof domain.query, "string");
  assert.equal(typeof domain.expected, "string");
}

// 真实组件由外部启动。模型夹具只检查工具目录、回执和凭据边界。
let active;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.ok(
      secrets.every((secret) => !body.includes(secret)),
      "模型收到组件凭据",
    );
    const { messages, tools = [] } = JSON.parse(body);
    const advertised = tools.map((entry) => entry.function);
    const names = active.tools.map((name) => {
      const matches = advertised.filter(
        (fn) => fn.name === name || fn.description?.endsWith(` / ${name}）`),
      );
      assert.equal(matches.length, 1, name);
      return matches[0].name;
    });
    assert.equal(advertised.length, names.length, "出现未声明的工具");
    const results = messages.filter(({ role }) => role === "tool");
    const step = results.length;
    if (step > 0) {
      assert.ok(
        JSON.stringify(results[step - 1].content).includes(active.expected),
        "Agent 未收到预期正文",
      );
    }
    if (step === active.tools.length) active.verified = true;
    const argumentsJson = JSON.stringify(step === 1 ? active.citation : { query: active.query });
    const delta =
      step < names.length
        ? {
            tool_calls: [
              {
                index: 0,
                id: `direct-consumer-${step}`,
                type: "function",
                function: { name: names[step], arguments: argumentsJson },
              },
            ],
          }
        : { content: "DIRECT_CONSUMER_OK" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: step < names.length ? "tool_calls" : "stop" },
    ]) {
      response.write(
        "data: " +
          JSON.stringify({ id: "direct-consumer", choices: [{ index: 0, ...choice }] }) +
          "\n\n",
      );
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    active.error = error;
    response.writeHead(500).end();
  }
});
let unavailableHits = 0;
const unavailable = createServer((_request, response) => {
  unavailableHits++;
  response.writeHead(503).end();
});
for (const server of [model, unavailable]) server.listen(0, "127.0.0.1");
await Promise.all([model, unavailable].map((server) => once(server, "listening")));
const base = { ...process.env, PYTHONUTF8: "1" };
for (const key of [
  "COREMIND_MODEL_NAME",
  "COREMIND_MODEL_BASE_URL",
  "COREMIND_MODEL_API_KEY",
  "COREMIND_WORKER_PATH",
  "PYTHONPATH",
  ...domains.map((domain) => domain.tokenKey),
])
  delete base[key];
const output = [];

async function launch(domain, command, endpoint, modelEnabled = false) {
  const env = { ...base, [domain.urlKey]: endpoint.url };
  if (endpoint.authorization) env[domain.tokenKey] = endpoint.authorization;
  if (modelEnabled)
    Object.assign(env, {
      COREMIND_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`,
      COREMIND_MODEL_NAME: "fixture",
      COREMIND_MODEL_API_KEY: "synthetic-loopback",
    });
  return run(domain.executable, [...command, domain.query], {
    cwd: domain.cwd,
    env,
    timeout: 40_000,
    encoding: "utf8",
  });
}

try {
  for (const domain of domains) {
    const record = (name, details = {}) =>
      output.push({ domain: domain.id, case: name, ...details });
    const first = JSON.parse((await launch(domain, domain.direct, domain)).stdout);
    const hit = first[domain.field].find((item) => item.text.includes(domain.expected));
    assert.ok(hit, `${domain.id} 直接调用缺少预期正文`);
    let citation;
    if (domain.id === "knowledge") {
      assert.deepEqual(
        first.resolved.map((item) => item.text),
        first.citations.map((item) => item.text),
      );
      const { docId, file, version, chunkId, line, locator } = hit;
      citation = {
        docId,
        file,
        version,
        ...(chunkId != null ? { chunkId } : line != null ? { line } : { locator }),
      };
    } else {
      assert.ok(hit.bankId && hit.documentId && hit.version);
    }
    record("direct-without-model", {
      ...(citation && {
        citationPosition: hit.chunkId != null ? "chunkId" : hit.line != null ? "line" : "locator",
      }),
    });
    const restricted = JSON.parse((await launch(domain, domain.direct, domain.other)).stdout);
    assert.deepEqual(restricted[domain.field], []);
    record("other-reader-empty");
    for (const [name, endpoint] of [
      ["missing-credential", { url: domain.url }],
      ["invalid-credential", { url: domain.url, authorization: "Bearer invalid-test-token" }],
      [
        "unavailable",
        {
          url: `http://127.0.0.1:${unavailable.address().port}/mcp`,
          authorization: domain.authorization,
        },
      ],
    ]) {
      await assert.rejects(launch(domain, domain.direct, endpoint), (error) => {
        assert.notEqual(error.code, 0);
        assert.equal(error.killed, false, "超时不能计作明确拒绝");
        assert.ok(
          secrets.every((secret) => !error.stderr.includes(secret)),
          "错误输出暴露凭据",
        );
        return true;
      });
      record(name);
    }
    active = { ...domain, citation };
    const { stdout } = await launch(domain, domain.agent, domain, true).catch((error) => {
      throw active.error ?? error;
    });
    assert.match(stdout, /DIRECT_CONSUMER_OK/);
    assert.ok(active.verified);
    record("agent-same-service", { calls: domain.tools.length });
    const before = unavailableHits;
    active = { tools: [] };
    const removed = await launch(
      domain,
      domain.removed,
      {
        url: `http://127.0.0.1:${unavailable.address().port}/mcp`,
      },
      true,
    );
    assert.match(removed.stdout, /DIRECT_CONSUMER_OK/);
    assert.ok(active.verified);
    assert.equal(unavailableHits, before, "移除组件后仍访问该服务");
    record("runtime-only-after-removal");
  }
  assert.equal(unavailableHits, 2, "两次不可用检查均应访问测试端点");
  console.log(JSON.stringify({ cases: output, count: output.length }, null, 2));
} finally {
  for (const server of [model, unavailable]) server.close();
}
