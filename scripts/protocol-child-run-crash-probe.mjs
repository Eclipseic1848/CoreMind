import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerEntry = path.join(
  scriptDirectory,
  "..",
  "packages",
  "coremind-worker",
  "dist",
  "index.js",
);
const [configDir, configPath, runId] = process.argv.slice(2);
if (!configDir || !configPath || !runId) {
  throw new Error("需要 configDir、configPath 与 runId");
}

process.env.DEEPSEEK_API_KEY ??= "test-only";

function sendSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function delegationResponse() {
  return [
    {
      id: "parent-delegation",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-delegate-crash-child",
                type: "function",
                function: {
                  name: "delegate",
                  arguments:
                    '{"target":"researcher","task":"写入一次 marker 后等待","references":[],"limits":{}}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: "parent-delegation",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ];
}

function writeMarkerResponse() {
  return [
    {
      id: "child-write",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-child-effect",
                type: "function",
                function: {
                  name: "write",
                  arguments: '{"path":"effect-marker.log","content":"child-effect\\n"}',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { id: "child-write", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

let ready = false;
const server = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const payload = JSON.parse(body);
    const hasToolResult = payload.messages?.some((message) => message.role === "tool") ?? false;
    const hasDelegationTool =
      payload.tools?.some((tool) => tool.function?.name === "delegate") ?? false;
    if (hasDelegationTool) {
      sendSse(response, delegationResponse());
      return;
    }
    if (!hasToolResult) {
      sendSse(response, writeMarkerResponse());
      return;
    }
    if (!ready) {
      ready = true;
      process.stdout.write("READY\n");
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const config = {
  schemaVersion: 2,
  name: "Protocol Child crash probe",
  provider: {
    id: "probe",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "parent-model",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  agents: {
    main: {
      systemPrompt: "你是父 Agent。",
      tools: [{ id: "write" }],
      delegation: {
        budget: {
          tokens: 2000,
          toolCalls: 4,
          costUsd: 2,
          wallTimeMs: 30000,
          steps: 4,
          descendants: 1,
        },
        limits: { maxDepth: 2, maxActiveChildren: 1, maxDescendants: 1 },
        targets: {
          researcher: {
            budget: {
              tokens: 1000,
              toolCalls: 2,
              costUsd: 1,
              wallTimeMs: 20000,
              steps: 2,
              descendants: 0,
            },
          },
        },
      },
    },
    researcher: {
      systemPrompt: "你是 Child Agent。",
      model: "researcher-model",
      tools: [{ id: "write" }],
    },
  },
  defaultAgent: "main",
  runtime: {
    maxSteps: 8,
    maxToolCalls: 8,
    maxTokens: 4000,
    maxCostUsd: 4,
    runTimeoutMs: 60000,
  },
  permissions: { mode: "full", workspaceOnly: true, network: "allow" },
};
await writeFile(configPath, JSON.stringify(config), "utf8");

const { ProtocolHost } = await import(pathToFileURL(workerEntry).href);
const host = new ProtocolHost({ send: () => {} });
await host.handle({
  jsonrpc: "2.0",
  id: "initialize-child-crash-probe",
  method: "initialize",
  params: {
    protocolRange: { minVersion: "2.0", maxVersion: "2.0" },
    config,
    configDir,
    cwd: configDir,
  },
});
await host.handle({
  jsonrpc: "2.0",
  protocolVersion: "2.0",
  id: "run-child-crash-probe",
  method: "run",
  params: { runId, input: "启动 Child 并等待" },
});

await new Promise(() => {});
