import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";

const [consumer, python, source, model] = process.argv.slice(2).map((arg) => path.resolve(arg));
assert.ok(
  consumer && python && source && model,
  "请提供 npm 消费者目录、Python 解释器、归档源码和模型目录",
);
const examples = path.join(source, "examples/modules/manage-knowledge");
const cli = path.join(consumer, "node_modules/coremind-cli/dist/cli.js");
const question = "现行的普通咨询要从哪个栏目递交？";
const expected = {
  docId: "资料室手册",
  version: 2,
  file: "资料室手册-v2.md",
  line: 5,
  text: "普通咨询从资料室的“读者来信”栏提交。",
};
const exec = promisify(execFile);
const auth = `Bearer ${randomBytes(24).toString("hex")}`;
const env = {
  ...process.env,
  COREMIND_KNOWLEDGE_AUTHORIZATION: auth,
  COREMIND_KNOWLEDGE_FIXTURE_KEY: "consumer-probe",
  NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
};
for (const key of ["COREMIND_WORKER_PATH", "PYTHONPATH", "NODE_PATH", "NODE_OPTIONS"])
  delete env[key];

function textOf({ content }) {
  return typeof content === "string" ? content : content.map(({ text }) => text).join("");
}

let fixtureError;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.ok(!body.includes(auth.slice("Bearer ".length)), "查询服务令牌进入了 Provider 请求");
    const { messages, tools } = JSON.parse(body);
    const result = messages.findLast(({ role }) => role === "tool");
    let delta;
    if (result) {
      const { citations } = JSON.parse(textOf(result));
      const hit = citations.find(
        ({ docId, version, line }) =>
          docId === expected.docId && version === expected.version && line === expected.line,
      );
      assert.deepEqual(hit, expected);
      delta = { role: "assistant", content: JSON.stringify(hit) };
    } else {
      assert.equal(tools.length, 1);
      const query = textOf(messages.findLast(({ role }) => role === "user"));
      assert.equal(query, question);
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "consumer-knowledge-search",
            type: "function",
            function: { name: tools[0].function.name, arguments: JSON.stringify({ query }) },
          },
        ],
      };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [content, reason] of [
      [delta, null],
      [{}, result ? "stop" : "tool_calls"],
    ]) {
      const data = {
        id: "local-consumer",
        choices: [{ index: 0, delta: content, finish_reason: reason }],
      };
      response.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});

const ts = `
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";
const installed = fileURLToPath(import.meta.resolve("coremind-ai"));
assert.ok(installed.startsWith(path.join(process.cwd(), "node_modules") + path.sep), installed);
const [configFile, initialPrompt] = process.argv.slice(1);
const { config } = parseAndValidate(await loadConfigFile(configFile));
const runtime = await CoreMindRuntime.create({ config, configDir: path.dirname(configFile), initialPrompt });
const result = await runtime.run();
assert.equal(result.outcome.status, "succeeded", JSON.stringify(result.outcome));
console.log(result.transcript);
`;
const py = `
import asyncio, sys
from pathlib import Path
import coremind
from coremind import AsyncCoreMindClient, CoreMindClient

assert Path(coremind.__file__).resolve().is_relative_to(Path(sys.prefix).resolve()), coremind.__file__
assert sys.prefix != sys.base_prefix
config, prompt, mode = sys.argv[1:]

async def run_async():
    async with AsyncCoreMindClient(Path(config)) as client:
        return await client.run(prompt)

if mode == 'async':
    result = asyncio.run(run_async())
else:
    with CoreMindClient(Path(config)) as client:
        result = client.run(prompt)
assert result['outcome']['status'] == 'succeeded', result['outcome']
print(result['transcript'])
`;

await new Promise((resolve, reject) => {
  provider.once("error", reject);
  provider.listen(0, "127.0.0.1", resolve);
});
try {
  const yaml = await readFile(path.join(examples, "coremind.yaml"), "utf8");
  for (const rebuild of [1, 2]) {
    const start = performance.now();
    const service = spawn(
      python,
      [
        "-B",
        "-X",
        "utf8",
        path.join(examples, "knowledge_server.py"),
        "--model-dir",
        model,
        "--port",
        "0",
      ],
      { cwd: consumer, env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    service.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += stripVTControlCharacters(chunk);
    });
    const exited = once(service, "exit");
    try {
      const listening = /Uvicorn running on http:\/\/127\.0\.0\.1:(\d+)/u;
      while (
        !listening.test(stderr) &&
        service.exitCode === null &&
        performance.now() - start < 120_000
      ) {
        await Promise.race([exited, delay(100)]);
      }
      const port = listening.exec(stderr)?.[1];
      assert.ok(port, stderr || "知识服务未就绪");
      const health = `http://127.0.0.1:${port}/health`;
      assert.equal((await fetch(health, { signal: AbortSignal.timeout(5000) })).status, 401);
      const ready = await fetch(health, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(5000),
      });
      assert.deepEqual(await ready.json(), {
        status: "ready",
      });
      console.log(
        JSON.stringify({
          rebuild,
          readySeconds: (performance.now() - start) / 1000,
          status: "ready",
        }),
      );
      const config = path.join(
        await mkdtemp(path.join(consumer, "knowledge-probe-")),
        "coremind.yaml",
      );
      await writeFile(
        config,
        yaml
          .replace("127.0.0.1:8767", `127.0.0.1:${port}`)
          .replace("127.0.0.1:8768", `127.0.0.1:${provider.address().port}`),
        "utf8",
      );
      const entries = [
        [
          "CLI + YAML",
          process.execPath,
          [cli, "run", config, "--prompt", question, "--json-events"],
        ],
        [
          "TypeScript SDK",
          process.execPath,
          ["--input-type=module", "--eval", ts, config, question],
        ],
        ["Python SDK", python, ["-B", "-I", "-X", "utf8", "-c", py, config, question, "sync"]],
        [
          "Python Async SDK",
          python,
          ["-B", "-I", "-X", "utf8", "-c", py, config, question, "async"],
        ],
      ];
      for (const [entry, command, args] of entries) {
        const began = performance.now();
        fixtureError = undefined;
        const { stdout } = await exec(command, args, {
          cwd: consumer,
          env,
          timeout: 35_000,
          encoding: "utf8",
        }).catch((error) => {
          throw new Error(`${entry} 执行失败：${error.stderr || error.stdout || error.message}`, {
            cause: fixtureError ?? error,
          });
        });
        let text = stdout.trim();
        if (entry === "CLI + YAML") {
          const events = text.split("\n").map((line) => JSON.parse(line));
          assert.equal(
            events.find(({ type }) => type === "run_result")?.outcome.status,
            "succeeded",
          );
          text = events
            .filter(({ type }) => type === "text_delta")
            .map(({ delta }) => delta)
            .join("");
        }
        const citation = JSON.parse(text);
        assert.deepEqual(citation, expected);
        console.log(
          JSON.stringify({
            rebuild,
            entry,
            elapsedSeconds: (performance.now() - began) / 1000,
            exit: 0,
            citation,
          }),
        );
      }
    } finally {
      if (service.exitCode === null && service.signalCode === null) service.kill();
      await exited;
    }
  }
} finally {
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
}
