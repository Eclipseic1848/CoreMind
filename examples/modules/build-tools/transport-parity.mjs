import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CoreMindRuntime, defineTool, parseAndValidate } from "coremind-ai";
import { startMcpHttpServer } from "../../../test/fixtures/mcp-http-server.mjs";

const input = { value: { flag: false, count: 0, empty: null } };
const localCalls = [];
const localTool = defineTool({
  name: "echo_local",
  description: "回显合成参数",
  parameters: {
    type: "object",
    properties: { value: {} },
    required: ["value"],
    additionalProperties: false,
  },
  effect: { operations: ["read"], reversible: true },
  execute: (args) => {
    localCalls.push(args);
    return args.value;
  },
});

const temporaryRoot = await realpath(tmpdir());
const workspace = await mkdtemp(path.join(temporaryRoot, "coremind-transport-parity-"));
const stdioService = fileURLToPath(
  new URL("../../../test/fixtures/mcp-stdio-server.mjs", import.meta.url),
);
const stdioRecords = path.join(workspace, "stdio.jsonl");
const command = await realpath(process.execPath);
let fixtureError;
let modelRequests = 0;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    const { messages, tools } = JSON.parse(body);
    assert.equal(tools.length, 1);
    const turn = ++modelRequests;
    assert(turn <= 2, "回显示例只允许一个业务调用");
    const toolMessages = messages.filter(({ role }) => role === "tool");
    assert.equal(toolMessages.length, turn - 1);
    let delta;
    if (turn === 1) {
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "echo-fixture",
            type: "function",
            function: { name: tools[0].function.name, arguments: JSON.stringify(input) },
          },
        ],
      };
    } else {
      const content = toolMessages[0].content;
      const text =
        typeof content === "string" ? content : content.map(({ text }) => text).join("\n");
      const values = text.trim().split("\n").map(JSON.parse);
      for (const value of values) assert.deepEqual(value, input.value);
      delta = { content: JSON.stringify(values[0]) };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: turn === 1 ? "tool_calls" : "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: `echo-${turn}`, choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    fixtureError = error;
    response.writeHead(500).end();
  }
});

let http;
try {
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  http = await startMcpHttpServer();
  const servers = {
    stdio: {
      transport: "stdio",
      command,
      args: [stdioService, stdioRecords],
      cwd: workspace,
      protocolVersion: "2026-07-28",
    },
    "streamable-http": {
      transport: "streamable-http",
      url: http.url,
      allowedAddresses: ["127.0.0.1"],
      protocolVersion: "2026-07-28",
    },
  };
  for (const route of ["local", "stdio", "streamable-http"]) {
    const server = servers[route];
    const effect = route === "stdio" ? "external" : "network";
    const selectedTool = {
      mcp: { server: "fixture", tool: "echo" },
      effect: { operations: [effect], reversible: false },
      capability: {
        effect,
        replay: "unknown",
        concurrency: "run_serial",
        checkpoint: route === "stdio" ? "unsupported" : "none",
        durability: "critical",
      },
    };
    const approvals = [];
    modelRequests = 0;
    const { config } = parseAndValidate({
      schemaVersion: 3,
      name: "工具传输等价示例",
      provider: {
        id: "local-parity-fixture",
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        model: "echo",
      },
      defaultAgent: "main",
      agents: { main: server ? { tools: [selectedTool] } : {} },
      ...(server ? { mcp: { servers: { fixture: server } } } : {}),
      permissions: {
        mode: "ask",
        workspaceOnly: route !== "stdio",
        network: route === "stdio" ? "allow" : route === "streamable-http" ? "ask" : "deny",
        allow: server ? [] : [localTool.name],
      },
      runtime: { maxTurns: 3, maxToolCalls: 3, maxRetries: 0, runTimeoutMs: 20_000 },
    });
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: workspace,
      cwd: workspace,
      env: {},
      initialPrompt: "请调用回显工具并返回合成参数的值。",
      toolDefinitions: server ? [] : [localTool],
      approveTool: async ({ args }) => {
        const target = args.mcp ?? args;
        const operation = args.operation ?? target.tool;
        if (target.server !== "fixture" || !["connect", "list", "echo"].includes(operation))
          return "deny";
        if (route === "stdio") {
          assert.equal(target.command, command);
          assert.equal(target.cwd, workspace);
          assert.deepEqual(target.argv, servers.stdio.args);
        } else {
          assert.equal(route, "streamable-http");
          assert.equal(target.url, http.url);
        }
        if (operation === "echo") assert.deepEqual(args.arguments, input);
        approvals.push(operation);
        return "allow";
      },
    });
    const run = await runtime.run();
    if (fixtureError) throw fixtureError;
    assert.equal(run.outcome.status, "succeeded", JSON.stringify(run.outcome));
    assert.equal(modelRequests, 2);
    assert(await runtime.waitForQuiescence(), "运行结束后应回收传输活动");
    const value = JSON.parse(run.transcript);
    assert.deepEqual(value, input.value);
    assert.deepEqual(approvals, server ? ["connect", "list", "echo"] : []);

    if (server) {
      const records =
        route === "stdio"
          ? (await readFile(stdioRecords, "utf8")).trim().split("\n").map(JSON.parse)
          : http.records;
      const requests = records.filter(({ type }) => type === "request");
      assert.equal(requests.filter(({ method }) => method === "server/discover").length, 1);
      assert.deepEqual(
        requests
          .filter(({ method }) => method === "tools/call")
          .map(({ params: { name, arguments: args } }) => ({ name, arguments: args })),
        [{ name: "echo", arguments: input }],
      );
    } else assert.deepEqual(localCalls, [input]);
    console.log(JSON.stringify({ transport: route, calls: 1, approvals, value }));
  }
} finally {
  await http?.close();
  model.closeAllConnections();
  if (model.listening)
    await new Promise((resolve, reject) =>
      model.close((error) => (error ? reject(error) : resolve())),
    );
  const resolved = await realpath(workspace);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert(path.basename(resolved).startsWith("coremind-transport-parity-"));
  await rm(resolved, { recursive: true, force: true });
}
