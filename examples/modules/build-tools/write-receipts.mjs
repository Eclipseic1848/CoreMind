import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CoreMindError,
  CoreMindRuntime,
  defineTool,
  FileRunStore,
  fingerprintRunConfig,
  parseAndValidate,
  prepareRunResume,
} from "coremind-ai";
import {
  input,
  inputSchema,
  mcpReply,
  outputSchema,
  toolName,
  writeReceipt,
} from "./write-receipt-fixture.mjs";

const modes = ["normal", "missing", "invalid", "lost"];
const routes = ["local", "stdio", "streamable-http"];
const fixture = fileURLToPath(new URL("./write-receipt-fixture.mjs", import.meta.url));
const node = await realpath(process.execPath);
const expectedReceipt = { orderId: input.orderId, receiptId: `ledger:${input.orderId}` };

async function readRequest(request) {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

async function startServer(handle) {
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      await handle(request, response);
    } catch (error) {
      errors.push(error);
      response.writeHead(500).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    errors,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function sendCompletion(response, turn, tool) {
  const call = tool && {
    tool_calls: [
      {
        index: 0,
        id: `receipt-call-${turn}`,
        type: "function",
        function: { name: tool, arguments: JSON.stringify(input) },
      },
    ],
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const choice of [
    {
      delta: { role: "assistant", ...(call || { content: "发运登记检查结束。" }) },
      finish_reason: null,
    },
    { delta: {}, finish_reason: call ? "tool_calls" : "stop" },
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: `receipt-${turn}`, choices: [{ index: 0, ...choice }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}

function messageText({ content }) {
  return typeof content === "string" ? content : content.map((item) => item.text).join("\n");
}

async function runCase(route, mode, workspace) {
  const recordsPath = path.join(workspace, "business.jsonl");
  const runStore = new FileRunStore(path.join(workspace, "runs"));
  const callsFromModel = mode === "normal" ? 1 : 2;
  let toolAlias;
  let modelTurns = 0;
  const model = await startServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const { messages, tools } = await readRequest(request);
    assert.equal(tools.length, 1);
    toolAlias ??= tools[0].function.name;
    assert.equal(tools[0].function.name, toolAlias);
    modelTurns += 1;
    assert(modelTurns <= callsFromModel + 1);
    const toolMessages = messages.filter(({ role }) => role === "tool");
    assert.equal(toolMessages.length, modelTurns - 1);
    if (mode === "normal" && toolMessages.length) {
      for (const line of messageText(toolMessages[0]).trim().split("\n"))
        assert.deepEqual(JSON.parse(line), expectedReceipt);
    }
    if (mode !== "normal" && toolMessages.length === 2) {
      assert.match(messageText(toolMessages[1]), /写入效果尚未确认/);
    }
    sendCompletion(response, modelTurns, modelTurns <= callsFromModel ? toolAlias : undefined);
  });

  let http;
  try {
    if (route === "streamable-http") {
      http = await startServer(async (request, response) => {
        assert.equal(request.url, "/mcp");
        if (request.method !== "POST") {
          response.writeHead(request.method === "DELETE" ? 202 : 405).end();
          return;
        }
        const result = mcpReply(recordsPath, mode, await readRequest(request));
        if (result === undefined) response.destroy();
        else if (result === null) response.writeHead(202).end();
        else
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(result));
      });
    }
    const server = http
      ? {
          transport: "streamable-http",
          url: `${http.baseUrl}/mcp`,
          allowedAddresses: ["127.0.0.1"],
          protocolVersion: "2026-07-28",
        }
      : route === "stdio"
        ? {
            transport: "stdio",
            command: node,
            args: [fixture, recordsPath, mode],
            cwd: workspace,
            protocolVersion: "2026-07-28",
          }
        : undefined;
    const operation = http ? "network" : "external";
    const effect = { operations: [operation], reversible: false };
    const capability = {
      effect: operation,
      replay: "unsafe",
      concurrency: "run_serial",
      checkpoint: http ? "none" : "unsupported",
      durability: "critical",
    };
    const selected = { mcp: { server: "fixture", tool: toolName }, effect, capability };
    const { config } = parseAndValidate({
      schemaVersion: 3,
      name: "发运回执验收",
      provider: { id: "local-receipt-fixture", baseUrl: `${model.baseUrl}/v1`, model: "receipt" },
      defaultAgent: "main",
      agents: { main: server ? { tools: [selected] } : {} },
      ...(server ? { mcp: { servers: { fixture: server } } } : {}),
      permissions: {
        mode: "ask",
        workspaceOnly: Boolean(http),
        network: http ? "ask" : "allow",
        allow: server ? [] : [toolName],
      },
      runtime: { maxTurns: 5, maxToolCalls: 5, maxRetries: 0, runTimeoutMs: 25_000 },
    });
    const local = server
      ? []
      : [
          defineTool({
            name: toolName,
            description: "登记合成订单发运并返回账本回执",
            parameters: inputSchema,
            outputSchema,
            effect,
            capability,
            execute: (args) => {
              const receipt = writeReceipt(recordsPath, mode, args);
              if (receipt === undefined) {
                throw new CoreMindError("tool_execution_failed", "发运写入后丢失返回");
              }
              return receipt;
            },
          }),
        ];
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: workspace,
      cwd: workspace,
      runStore,
      toolDefinitions: local,
      env: {},
      initialPrompt: "登记合成订单并核对业务回执。",
      approveTool: async ({ tool, args }) => {
        if (!server) {
          if (tool !== toolName) return "deny";
          assert.deepEqual(args, input);
          return "allow";
        }
        const target = args.mcp ?? args;
        if (
          target.server !== "fixture" ||
          !["connect", "list", toolName].includes(args.operation ?? target.tool)
        )
          return "deny";
        if (http) assert.equal(target.url, server.url);
        else {
          assert.equal(target.command, node);
          assert.equal(target.cwd, workspace);
          assert.deepEqual(target.argv, server.args);
        }
        if (target.tool === toolName) assert.deepEqual(args.arguments, input);
        return "allow";
      },
    });
    const run = await runtime.run();
    assert(await runtime.waitForQuiescence());
    assert.deepEqual(model.errors, []);
    assert.deepEqual(http?.errors ?? [], []);
    assert.equal(
      modelTurns,
      callsFromModel + 1,
      JSON.stringify({
        outcome: run.outcome,
        denied: run.trace
          .filter(({ event }) => event.type === "policy_denied")
          .map(({ event }) => event.reason),
      }),
    );
    const log = await readFile(recordsPath, "utf8");
    const businessWrites = log.trim().split("\n").map(JSON.parse);
    assert.deepEqual(businessWrites, [expectedReceipt]);
    const facts = await runStore.read(run.runId);
    const eventOf = (fact) => (fact.kind === "event" ? fact.payload.event : undefined);
    const events = facts.map(eventOf).filter((event) => event?.tool === toolAlias);
    const attempts = events.filter(({ type }) => type === "tool_call").map(({ callId }) => callId);
    assert.equal(attempts.length, callsFromModel);
    assert.equal(new Set(attempts).size, callsFromModel);
    const receipts = events.filter(({ type }) => type === "effect_receipt");
    const statusFor = (call) =>
      receipts.filter(({ callId }) => callId === call).map(({ status }) => status);
    const status = mode === "normal" ? "committed" : "unknown";
    assert.deepEqual(statusFor(attempts[0]), ["started", status]);
    assert.equal(receipts.length, status === "unknown" ? 3 : 2);
    const results = events.filter(({ type }) => type === "tool_result");
    assert(
      results.some(
        ({ callId, isError }) => callId === attempts[0] && isError === (status === "unknown"),
      ),
    );
    if (status === "unknown") {
      assert.deepEqual(statusFor(attempts[1]), ["not_started"]);
      assert(
        results.some(({ callId, isError }) => callId === attempts[1] && isError),
        "重复写入应被拒绝",
      );
    }

    let coldRecovery = null;
    if (status === "unknown") {
      const end = facts.findIndex((fact) => {
        const event = eventOf(fact);
        return (
          event?.type === "effect_receipt" &&
          event.callId === attempts[0] &&
          event.status === "unknown"
        );
      });
      assert(end > 0);
      assert.throws(
        () => prepareRunResume(facts.slice(0, end + 1), fingerprintRunConfig(config)),
        (error) => {
          coldRecovery = error.code;
          return ["unknown_effect", "committed_effect_pending"].includes(coldRecovery);
        },
      );
      assert.equal(await readFile(recordsPath, "utf8"), log);
      assert.deepEqual(await runStore.read(run.runId), facts);
    }
    return {
      route,
      mode,
      result: status,
      modeledCalls: attempts.length,
      businessWrites: businessWrites.length,
      receipts: statusFor(attempts[0]),
      retryReceipts: status === "unknown" ? statusFor(attempts[1]) : [],
      coldRecovery,
    };
  } finally {
    await http?.close();
    await model.close();
  }
}

const { values } = parseArgs({ options: { output: { type: "string" } } });
const temporaryRoot = await realpath(tmpdir());
const workspace = await mkdtemp(path.join(temporaryRoot, "coremind-write-receipts-"));
try {
  const cases = [];
  for (const route of routes) {
    for (const mode of modes) {
      const directory = path.join(workspace, `${route}-${mode}`);
      await mkdir(directory);
      try {
        cases.push(await runCase(route, mode, directory));
      } catch (error) {
        throw new Error(`回执验收失败 ${route}/${mode}`, { cause: error });
      }
    }
  }
  const report = `${JSON.stringify({ passed: true, cases }, null, 2)}\n`;
  if (values.output) {
    await mkdir(path.dirname(values.output), { recursive: true });
    await writeFile(values.output, report, "utf8");
  }
  process.stdout.write(report);
} finally {
  const resolved = await realpath(workspace);
  assert.equal(path.dirname(resolved), temporaryRoot);
  assert(path.basename(resolved).startsWith("coremind-write-receipts-"));
  await rm(resolved, { recursive: true, force: true });
}
