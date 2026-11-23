import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { CoreMindRuntime } from "coremind-ai";

const [packageJson, browserExecutable, evidenceDirectory] = process.argv.slice(2);
if (!packageJson || !browserExecutable || process.argv.length > 5) {
  throw new Error(
    "用法：node run.mjs <@playwright/mcp package.json> <Chrome 可执行文件> [证据目录]",
  );
}
const mcpPackage = JSON.parse(await readFile(packageJson, "utf8"));
assert.equal(mcpPackage.name, "@playwright/mcp");
assert.equal(mcpPackage.version, "0.0.81");
const chrome = await realpath(browserExecutable);
const cli = await realpath(
  path.resolve(path.dirname(packageJson), mcpPackage.bin["playwright-mcp"]),
);
const launcher = fileURLToPath(new URL("./mcp-launcher.mjs", import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "coremind-browser-"));
const pidFile = path.join(root, "mcp.pid");
const screenshot = path.join(root, "filtered.png");
const period = "2026-10";
const total = "42 TEST-ONLY";
const csv = `period,total\n${period},42\n`;
const providerKey = "fixture-only";
const toolNames = [
  "browser_navigate",
  "browser_type",
  "browser_click",
  "browser_snapshot",
  "browser_take_screenshot",
];

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  const closing = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections();
  await closing;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function ownedPids() {
  const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
  assert.ok(pids.every((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid));
  return pids;
}

let active;
let filteredRequests = 0;
let downloads = 0;
const page = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/wait") {
    active.enteredWait = true;
    active.pendingPids = ownedPids();
    active.pendingProcessesAlive = active.pendingPids.every(isAlive);
    response.on("close", () => {
      active.closedWait = !response.writableFinished;
    });
    active.controller.abort();
    return;
  }
  const selected = url.searchParams.get("period") === period;
  if (url.pathname === "/report.csv" && selected) {
    downloads++;
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="report.csv"',
    });
    response.end(csv);
    return;
  }
  if (url.pathname !== "/") {
    response.writeHead(404).end();
    return;
  }
  if (selected) filteredRequests++;
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'",
  });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic report</title>
    <h1>Synthetic monthly report</h1>
    <form method="get"><label for="period">Month</label><input id="period" name="period">
    <button id="filter">Filter</button></form>
    ${selected ? `<p>${period}: ${total}</p><a id="report" href="/report.csv?period=${period}">Download CSV</a>` : "<p>Choose a month</p>"}</html>`);
});

const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    const { messages, tools } = JSON.parse(body);
    active.toolMessages = messages.filter(({ role }) => role === "tool");
    const index = active.modelRequests++;
    const step = active.steps[index];
    const [tool, args] = step ?? [];
    if (tool === "browser_take_screenshot") {
      assert.match(JSON.stringify(messages), new RegExp(total, "u"));
    }
    let delta = { role: "assistant", content: "合成网页验证完成" };
    if (step) {
      const declaration = tools.find(({ function: fn }) =>
        fn.name.startsWith(`mcp_browser_${tool.slice(0, 12)}_`),
      );
      assert.ok(declaration, `模型未收到已批准的 ${tool}`);
      delta = {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `browser-call-${index}`,
            type: "function",
            function: { name: declaration.function.name, arguments: JSON.stringify(args) },
          },
        ],
      };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: step ? "tool_calls" : "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  } catch (error) {
    active.modelError = error;
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "合成模型夹具失败" } }));
  }
});

try {
  const origin = await listen(page);
  const provider = await listen(model);
  const config = {
    schemaVersion: 2,
    name: "本地浏览器 MCP 验收",
    provider: {
      id: "browser-fixture",
      model: "synthetic",
      baseUrl: `${provider}/v1`,
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    mcp: {
      servers: {
        browser: {
          transport: "stdio",
          command: process.execPath,
          args: [
            launcher,
            pidFile,
            cli,
            chrome,
            "--headless",
            "--isolated",
            "--sandbox",
            "--block-service-workers",
            "--allowed-origins",
            origin,
            "--executable-path",
            chrome,
            "--output-dir",
            root,
            "--image-responses",
            "omit",
            "--timeout-navigation",
            "10000",
          ],
          cwd: root,
        },
      },
    },
    agents: {
      main: {
        tools: toolNames.map((tool) => ({
          mcp: { server: "browser", tool },
          effect: { operations: ["external"], reversible: false },
          capability: {
            effect: "external",
            replay: "unknown",
            concurrency: "run_serial",
            checkpoint: "unsupported",
            durability: "critical",
          },
        })),
      },
    },
    permissions: { mode: "ask", workspaceOnly: false, network: "allow" },
    runtime: { maxTurns: 10, maxToolCalls: 12, maxRetries: 0, runTimeoutMs: 40000 },
  };
  const cases = [
    {
      name: "accepted",
      status: "succeeded",
      steps: [
        ["browser_navigate", { url: `${origin}/` }],
        ["browser_type", { target: "#period", text: period }],
        ["browser_click", { target: "#filter" }],
        ["browser_snapshot", {}],
        ["browser_take_screenshot", { filename: "filtered.png", scale: "css" }],
        ["browser_click", { target: "#report" }],
      ],
    },
    { name: "denied", status: "paused", steps: [["browser_navigate", { url: `${origin}/wait` }]] },
    {
      name: "aborted",
      status: "aborted",
      steps: [["browser_navigate", { url: `${origin}/wait` }]],
    },
  ];

  const results = [];
  for (const sample of cases) {
    const controller = new AbortController();
    active = { ...sample, controller, modelRequests: 0, enteredWait: false, closedWait: false };
    const runtime = await CoreMindRuntime.create({
      config,
      configDir: root,
      cwd: root,
      env: { COREMIND_TEST_API_KEY: providerKey },
      initialPrompt: "核对授权的本地合成报表。",
      signal: controller.signal,
      approveTool: async (request) => {
        if (request.args?.mcp?.tool === "browser_navigate") {
          assert.equal(new URL(request.args.arguments.url).origin, origin);
          if (sample.name === "denied") return "deny";
        }
        return "allow";
      },
    });
    const result = await runtime.run();
    if (active.modelError) throw active.modelError;
    const toolResults = result.trace
      .map(({ event }) => event)
      .filter(({ type }) => type === "tool_result");
    assert.equal(
      result.outcome.status,
      sample.status,
      JSON.stringify({
        case: sample.name,
        outcome: result.outcome,
        modelRequests: active.modelRequests,
        toolResults,
      }),
    );
    if (sample.name === "accepted") {
      assert.ok(
        toolResults.every(({ isError }) => !isError),
        JSON.stringify(active.toolMessages.map(({ content }) => content)),
      );
    }
    if (sample.name === "denied") assert.equal(result.outcome.finishReason, "tool_approval_denied");
    const pids = ownedPids();
    assert.equal(pids.length, sample.name === "denied" ? 1 : 2);
    for (let attempt = 0; attempt < 50 && pids.some(isAlive); attempt++) await sleep(20);
    assert.ok(
      pids.every((pid) => !isAlive(pid)),
      `MCP 或测试 Chrome 进程未回收：${pids.join(", ")}`,
    );
    await rm(pidFile);
    assert.equal(active.enteredWait, sample.name === "aborted");
    if (sample.name === "aborted") {
      assert.deepEqual(active.pendingPids, pids);
      assert.equal(active.pendingProcessesAlive, true);
      for (let attempt = 0; attempt < 50 && !active.closedWait; attempt++) await sleep(20);
      assert.equal(active.closedWait, true, "取消应关闭浏览器在途连接");
    }
    results.push({
      name: sample.name,
      status: result.outcome.status,
      mcpPid: pids[0],
      mcpExited: true,
      chromePid: pids[1] ?? null,
      chromeExited: pids.length === 2 ? true : null,
      processesAliveBeforeAbort: active.pendingProcessesAlive ?? null,
      pendingBrowserRequestClosed: active.closedWait,
    });
  }
  assert.equal(filteredRequests, 1);
  assert.equal(downloads, 1);
  assert.equal(await readFile(path.join(root, "report.csv"), "utf8"), csv);
  const bytes = await readFile(screenshot);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const report = {
    playwrightMcp: mcpPackage.version,
    filteredRequests,
    downloads,
    screenshotBytes: bytes.length,
    results,
  };
  if (evidenceDirectory) {
    const evidence = await realpath(evidenceDirectory);
    await writeFile(path.join(evidence, "filtered.png"), bytes, { flag: "wx" });
    await writeFile(path.join(evidence, "report.csv"), csv, { encoding: "utf8", flag: "wx" });
    await writeFile(
      path.join(evidence, "browser-result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all([close(page), close(model)]);
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
