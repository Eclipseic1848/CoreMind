import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const [application, python, serviceFile] = process.argv.slice(2);
assert(
  application && python,
  "用法：node scripts/verify-optional-consumer.mjs <空白消费者> <wheel 的 Python> [本地服务配置 JSON]",
);
const root = path.resolve(application);
const cli = path.join(root, "node_modules", "coremind-cli", "dist", "cli.js");
const examples = fileURLToPath(new URL("../examples/modules/", import.meta.url));
const services = serviceFile ? JSON.parse(await readFile(serviceFile, "utf8")) : {};
const output = [];
const cases = [
  ["runtime", []],
  ["skill", ["skill"]],
  ["tool", ["tool"]],
  ...(serviceFile
    ? [
        ["knowledge", ["knowledge"]],
        ["memory", ["memory"]],
        ["ontology", ["ontology"]],
        ["knowledge-skill", ["knowledge", "skill"]],
        ["memory-tool", ["memory", "tool"]],
        ["memory-tool-ontology", ["memory", "tool", "ontology"]],
        ["remove-ontology", ["memory", "tool"]],
        ["remove-memory", ["tool"]],
      ]
    : []),
];
const skillName = "case-format";
const specifications = {
  skill: { tool: "load_skill", args: { id: skillName }, expect: "SKILL_COMPONENT_V1" },
  tool: { tool: "read", args: { path: "receipt.txt" }, expect: "BUSINESS_RECEIPT" },
  ...services,
};
let active;
const model = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    for (const { authorization } of Object.values(services)) {
      assert.ok(!body.includes(authorization), "模型请求暴露了服务凭据");
    }
    const { messages, tools = [] } = JSON.parse(body);
    const messagesFromTools = messages.filter((item) => item.role === "tool");
    const available = tools.map(({ function: fn }) => fn);
    const names = available.map((fn) => fn.name);
    assert.equal(available.length, active.scenario.length, names.join(","));
    const toolByName = new Map();
    for (const spec of active.scenario) {
      const matches = available.filter(
        (fn) => fn.name === spec.tool || fn.description?.endsWith(` / ${spec.tool}）`),
      );
      assert.equal(matches.length, 1, names.join(","));
      toolByName.set(spec.tool, matches[0].name);
    }
    active.catalog = names;
    const index = messagesFromTools.length;
    if (index > 0) {
      const text = JSON.stringify(messagesFromTools[index - 1].content);
      assert.ok(text.includes(active.scenario[index - 1].expect), text.slice(0, 450));
      active.results[index - 1] = true;
    }
    const spec = active.scenario[index];
    const delta = spec
      ? {
          tool_calls: [
            {
              index: 0,
              id: `optional-${index}`,
              type: "function",
              function: {
                name: toolByName.get(spec.tool),
                arguments: JSON.stringify(spec.args),
              },
            },
          ],
        }
      : { content: "OPTIONAL_COMPONENT_CHECK_OK" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: spec ? "tool_calls" : "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: "optional-consumer", choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    active.error = error;
    response.writeHead(500).end();
  }
});
model.listen(0, "127.0.0.1");
await once(model, "listening");
const env = { ...process.env, COREMIND_OPTIONAL_MODEL_KEY: "local-fixture" };
delete env.PYTHONPATH;
delete env.COREMIND_WORKER_PATH;
for (const [domain, spec] of Object.entries(services)) {
  const url = new URL(spec.url);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(typeof spec.expect, "string");
  env[`COREMIND_TEST_${domain.toUpperCase()}`] = spec.authorization;
}

try {
  const working = path.join(root, "business-project");
  await mkdir(working);
  await cp(
    path.join(examples, "configure-coremind/runtime-only.mts"),
    path.join(working, "run.mts"),
  );
  await cp(path.join(examples, "configure-coremind/runtime_only.py"), path.join(working, "run.py"));
  const skillDir = path.join(working, "skills", skillName);
  const modes = [
    ["cli", process.execPath, [cli, "run", "coremind.yaml", "--prompt", "检查已选组件"]],
    ["typescript", process.execPath, ["run.mts"]],
    ["python-sync", python, ["run.py"]],
    ["python-async", python, ["run.py", "--async"]],
  ];
  let toolConfiguration;
  for (const [id, selected] of cases) {
    if (id === "skill") {
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        `---\nname: ${skillName}\ndescription: 合成格式说明\n---\n\nSKILL_COMPONENT_V1\n`,
        "utf8",
      );
    }
    if (id === "tool") {
      await writeFile(path.join(working, "receipt.txt"), "BUSINESS_RECEIPT\n", "utf8");
    }
    const bindings = {};
    const tools = [];
    const agent = { systemPrompt: "用获准的组件处理此任务。" };
    for (const domain of selected) {
      if (domain === "skill") agent.skills = [skillName];
      else if (domain === "tool") tools.push({ id: "read" });
      else {
        const { url, tool } = services[domain];
        bindings[domain] = {
          transport: "streamable-http",
          url,
          allowedAddresses: ["127.0.0.1"],
          headers: { Authorization: { env: `COREMIND_TEST_${domain.toUpperCase()}` } },
        };
        tools.push({
          mcp: { server: domain, tool },
          effect: { operations: ["network"], reversible: true },
          capability: {
            effect: "network",
            replay: "safe",
            concurrency: "run_serial",
            checkpoint: "none",
            durability: "critical",
          },
        });
      }
    }
    if (tools.length) agent.tools = tools;
    const config = {
      schemaVersion: 3,
      name: id,
      provider: {
        id: "component-test",
        model: "fixture",
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        apiKeyEnv: "COREMIND_OPTIONAL_MODEL_KEY",
      },
      ...(Object.keys(bindings).length ? { mcp: { servers: bindings } } : {}),
      agents: { main: agent },
      permissions: {
        mode: "assisted",
        workspaceOnly: true,
        network: "allow",
        allow: ["read", "load_skill"],
      },
      runtime: { maxRetries: 0, runTimeoutMs: 20_000 },
      quality: { profile: "development" },
    };
    // JSON 是 YAML 的子集，四个入口读取同一配置文件。
    await writeFile(path.join(working, "coremind.yaml"), JSON.stringify(config), "utf8");
    if (id === "runtime") toolConfiguration = config;
    for (const [mode, command, args] of modes) {
      active = { scenario: selected.map((key) => specifications[key]), results: [] };
      try {
        const { stdout } = await run(command, args, {
          cwd: working,
          env,
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.match(stdout, /OPTIONAL_COMPONENT_CHECK_OK/);
        assert.equal(active.results.length, selected.length);
      } catch (error) {
        throw active.error ?? error;
      }
      output.push({ case: id, mode, tools: active.catalog, calls: active.results.length });
      console.log(`${id} / ${mode}: ${active.results.length} 次调用`);
    }
  }
  const toolEntrypoint = path.join(examples, "build-tools/single-tool.mts");
  await cp(toolEntrypoint, path.join(working, "single-tool.mts"));
  await cp(
    path.join(examples, "build-tools/order-lookup.mjs"),
    path.join(working, "lookup-v1.mjs"),
  );
  await writeFile(
    path.join(working, "lookup-v2.mjs"),
    'export const lookupOrder = ({ id }) => ({ id, status: "settled", toolVersion: "2.0.0" });\n',
    "utf8",
  );
  await writeFile(
    path.join(working, "lookup-denied.mjs"),
    'import { writeFileSync } from "node:fs";\nexport function lookupOrder() { writeFileSync("denied-order-executed", "broken", "utf8"); }\n',
    "utf8",
  );
  for (const [label, implementation, expect] of [
    ["first", "lookup-v1.mjs", "1.0.0"],
    ["upgrade", "lookup-v2.mjs", "2.0.0"],
    ["rollback", "lookup-v1.mjs", "1.0.0"],
    ["removed", null, null],
    ["denied", "lookup-denied.mjs", null],
  ]) {
    const config = {
      ...toolConfiguration,
      name: `lookup-${label}`,
      permissions: {
        mode: "assisted",
        workspaceOnly: true,
        ...(label === "denied" ? { deny: ["lookup_order"] } : { allow: ["lookup_order"] }),
      },
    };
    await writeFile(path.join(working, "coremind.yaml"), JSON.stringify(config), "utf8");
    active = {
      scenario: implementation
        ? [{ tool: "lookup_order", args: { id: "A-100" }, expect: expect ?? "denied" }]
        : [],
      results: [],
    };
    try {
      const { stdout } = await run(
        process.execPath,
        ["single-tool.mts", ...(implementation ? [implementation] : [])],
        {
          cwd: working,
          env,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      if (label === "denied") assert.match(stdout, /denied/i);
      else assert.match(stdout, /OPTIONAL_COMPONENT_CHECK_OK/);
    } catch (error) {
      if (active.error || label !== "denied") throw active.error ?? error;
      assert.match(error.stdout ?? "", /tool_approval_denied|denied|paused/i);
    }
    assert.equal(active.results.length, expect ? 1 : 0);
    await assert.rejects(access(path.join(working, "denied-order-executed")), { code: "ENOENT" });
    output.push({
      case: `lookup-${label}`,
      mode: "typescript",
      tools: active.catalog,
      calls: active.results.length,
    });
    console.log(`lookup-${label} / typescript: ${active.results.length} 次调用`);
  }
  await writeFile(
    path.join(root, "optional-acceptance.json"),
    JSON.stringify(output, null, 2),
    "utf8",
  );
} finally {
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
}
