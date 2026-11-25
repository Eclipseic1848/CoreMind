import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";
import { startLocalPython, startOntology } from "./ontology-fixture.mjs";

const exec = promisify(execFile);
const example = import.meta.dirname;
const root = path.resolve(example, "../../..");
const python = process.env.COREMIND_ONTOLOGY_PYTHON ?? "python";
const workspace = await mkdtemp(path.join(tmpdir(), "coremind-ontology-"));
const auth = "Bearer ontology-fixture-read-only-token";
const actionAuth = "Bearer ontology-fixture-action-token";
const modelKey = "local-ontology-fixture-key";
const env = {
  ...process.env,
  COREMIND_ONTOLOGY_FIXTURE_KEY: modelKey,
  PYTHONPATH: path.join(root, "python/src"),
  PYTHONIOENCODING: "utf-8",
};
delete env.COREMIND_ONTOLOGY_AUTHORIZATION;
delete env.COREMIND_ONTOLOGY_ACTION_AUTHORIZATION;
const fixture = { python, cwd: workspace, env, readToken: auth, actionToken: actionAuth };

const prompt = "整理《值班指南》，核对资料状态并返回摘要。";
const summary = "值班指南已归档至资料室。";
const guide = { resource: "urn:doc:guide" };
const draft = { resource: "urn:doc:draft" };
const record = { externalId: "A3", 状态: "R", 克重: 1250, owner: "urn:person:li" };
const { owner: _owner, ...withoutOwner } = record;
const describe = { tool: "ontology_describe", args: guide };
const validate = { tool: "ontology_validate_record", args: { source: "catalog", record } };
const inspect = { tool: "ontology_inspect_action", args: { action: "publish", ...guide } };
const perform = {
  tool: "ontology_perform_action",
  args: { action: "publish", ...guide, request_id: "release-fixture-001" },
};

function textOf({ content }) {
  return typeof content === "string" ? content : content.map(({ text }) => text).join("");
}

let active;
const provider = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, `Bearer ${modelKey}`);
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.ok(!body.includes(auth) && !body.includes(actionAuth), "MCP 令牌进入了模型请求");
    const { messages, tools = [] } = JSON.parse(body);
    assert.equal(textOf(messages.findLast(({ role }) => role === "user")), prompt);
    const turn = active.turns++;
    const previous = messages.filter(({ role }) => role === "tool").map(textOf);
    assert.equal(previous.length, turn);
    const expectedTools = [...new Set(active.calls.map(({ tool }) => tool))].sort();
    assert.deepEqual(
      tools.map(({ function: tool }) => / \/ (\w+)）$/.exec(tool.description)?.[1]).sort(),
      expectedTools,
    );
    const next = active.calls[turn];
    let delta;
    if (next) {
      const matches = tools.filter(({ function: tool }) =>
        tool.description.endsWith(` / ${next.tool}）`),
      );
      assert.equal(matches.length, 1, `找不到已声明的 MCP 工具 ${next.tool}`);
      delta = {
        tool_calls: [
          {
            index: 0,
            id: `ontology-${turn}`,
            type: "function",
            function: {
              name: matches[0].function.name,
              arguments: JSON.stringify(next.args),
            },
          },
        ],
      };
    } else {
      delta = { content: JSON.stringify({ summary, results: previous.map(JSON.parse) }) };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: next ? "tool_calls" : "stop" },
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: `ontology-${turn}`, choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    active.error = error;
    response.writeHead(500).end();
  }
});

async function checkHealth(service, status) {
  const health = `${service.origin}/health`;
  assert.equal((await fetch(health, { signal: AbortSignal.timeout(5000) })).status, 401);
  const response = await fetch(health, {
    headers: { Authorization: auth },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status });
}

async function configFor(cwd, service) {
  const template = await readFile(
    path.join(example, service ? "coremind.yaml" : "coremind-off.yaml"),
    "utf8",
  );
  const config = path.join(cwd, "coremind.yaml");
  const localProvider = `http://127.0.0.1:${provider.address().port}/v1`;
  await writeFile(
    config,
    template
      .replace("http://127.0.0.1:8880/v1", localProvider)
      .replace("http://127.0.0.1:8879", service?.origin ?? ""),
    "utf8",
  );
  return config;
}

async function runFour(id, service, calls, verify) {
  let reference;
  for (const entry of ["CLI + YAML", "TypeScript SDK", "Python SDK", "Python Async SDK"]) {
    const cwd = await mkdtemp(path.join(workspace, "project-"));
    const config = await configFor(cwd, service);
    const cli = entry === "CLI + YAML";
    const isPython = entry.startsWith("Python");
    const args = cli
      ? [
          path.join(root, "packages/coremind-cli/dist/cli.js"),
          "run",
          config,
          "--prompt",
          prompt,
          "--json-events",
        ]
      : isPython
        ? ["-B", "-X", "utf8", path.join(example, "run.py"), config, prompt]
        : [path.join(example, "run.mjs"), config, prompt];
    if (entry === "Python Async SDK") args.push("--async");
    active = { calls, turns: 0 };
    const { stdout } = await exec(isPython ? python : process.execPath, args, {
      cwd,
      env: service ? { ...env, COREMIND_ONTOLOGY_AUTHORIZATION: auth } : env,
      encoding: "utf8",
      timeout: 30_000,
    }).catch((error) => {
      throw new Error(`${entry} ${id} 执行失败：${error.stderr || error.message}`, {
        cause: active.error,
      });
    });
    assert.equal(active.turns, calls.length + 1);
    let transcript = stdout.trim();
    if (cli) {
      const events = transcript.split("\n").map(JSON.parse);
      assert.equal(events.find(({ type }) => type === "run_result")?.outcome.status, "succeeded");
      transcript = events
        .filter(({ type }) => type === "text_delta")
        .map(({ delta }) => delta)
        .join("");
    }
    const output = JSON.parse(transcript);
    assert.equal(output.summary, summary);
    verify(output.results);
    if (reference) assert.deepEqual(output, reference, `${entry} ${id} 的结果存在差异`);
    reference = output;
    console.log(
      JSON.stringify({ entry, case: id, statuses: output.results.map(({ status }) => status) }),
    );
  }
}

async function runAction(service, credential, call, decision, expected) {
  const cwd = await mkdtemp(path.join(workspace, "action-"));
  const raw = await loadConfigFile(await configFor(cwd, service));
  raw.mcp.servers.ontology.headers.Authorization.env = credential;
  raw.agents.main.tools = [
    {
      mcp: { server: "ontology", tool: call.tool },
      effect: { operations: ["external"], reversible: false },
      capability: {
        effect: "external",
        replay: "unsafe",
        concurrency: "run_serial",
        checkpoint: "unsupported",
        durability: "critical",
      },
    },
  ];
  raw.permissions = { mode: "ask", network: "allow", workspaceOnly: false };
  const { config } = parseAndValidate(raw);
  const events = [];
  let requests = 0;
  active = { calls: [call], turns: 0 };
  const runtime = await CoreMindRuntime.create({
    config,
    configDir: cwd,
    cwd,
    initialPrompt: prompt,
    env: {
      ...env,
      COREMIND_ONTOLOGY_AUTHORIZATION: auth,
      COREMIND_ONTOLOGY_ACTION_AUTHORIZATION: actionAuth,
    },
    events: (event) => events.push(event),
    approveTool: async (request) => {
      requests += 1;
      assert.equal(request.args.mcp.tool, call.tool);
      assert.deepEqual(request.args.arguments, call.args);
      assert.equal(request.capability.effect, "external");
      return decision;
    },
  });
  const result = await runtime.run();
  if (active.error) throw active.error;
  assert.equal(requests, 1);
  if (decision === "deny") {
    assert.ok(events.some(({ type }) => type === "policy_denied"));
    assert.equal(active.turns, 1);
    return;
  }
  assert.equal(result.outcome.status, "succeeded", JSON.stringify(result.outcome));
  assert.equal(active.turns, 2);
  const [action] = JSON.parse(result.transcript).results;
  assert.equal(action.status, expected);
  if (expected === "unknown") {
    const approval = events.find(({ type }) => type === "approval_required");
    assert.deepEqual(
      events
        .filter(({ type, tool }) => type === "effect_receipt" && tool === approval.tool)
        .map(({ status }) => status),
      ["started", "unknown"],
    );
  }
  return action;
}

let service;
try {
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  await runFour("off", undefined, [], (results) => assert.deepEqual(results, []));

  const bundle = path.join(example, "models", "document-review");
  service = await startOntology(bundle, { ...fixture, enableActions: true });
  await checkHealth(service, "ready");
  await runFour(
    "enabled",
    service,
    [
      describe,
      validate,
      { ...validate, args: { source: "catalog", record: withoutOwner } },
      { ...validate, args: { source: "catalog", record: { ...record, externalId: "A2" } } },
      inspect,
      { ...inspect, args: { action: "publish", ...draft } },
    ],
    ([object, good, invalid, ambiguous, proposal, denied]) => {
      assert.equal(object.status, "available");
      assert.equal(object.resource, guide.resource);
      assert.equal(object.found, true);
      assert.ok(object.types.length && object.properties.length && object.relationships.length);
      assert.match(object.modelDigest, /^[a-f0-9]{64}$/);
      assert.equal(good.status, "conforms");
      assert.equal(good.modelDigest, object.modelDigest);
      assert.equal(invalid.status, "violates");
      assert.ok(invalid.violations.length);
      assert.equal(ambiguous.status, "needs_confirmation");
      assert.equal(proposal.status, "ready");
      assert.equal(denied.reason, "precondition_failed");
    },
  );
  const readAuth = "COREMIND_ONTOLOGY_AUTHORIZATION";
  const writeAuth = "COREMIND_ONTOLOGY_ACTION_AUTHORIZATION";
  assert.equal(
    (await runAction(service, readAuth, perform, "allow", "denied")).reason,
    "action_not_authorized",
  );
  await runAction(service, writeAuth, perform, "deny");
  const wrongState = { ...perform, args: { ...perform.args, ...draft, request_id: "draft-001" } };
  assert.equal(
    (await runAction(service, writeAuth, wrongState, "allow", "denied")).reason,
    "precondition_failed",
  );
  const success = await runAction(service, writeAuth, perform, "allow", "completed");
  assert.equal(success.state, success.expectedState);
  assert.equal(success.replayed, undefined, "拒绝的调用不能形成业务回执");
  assert.equal((await runAction(service, writeAuth, perform, "allow", "completed")).replayed, true);
  console.log(
    JSON.stringify({
      case: "action",
      approvals: "read_denied,policy_denied,precondition_denied,completed,replayed",
    }),
  );

  await service.close();
  const outageConfig = await configFor(workspace, service);
  active = { calls: [describe], turns: 0 };
  await assert.rejects(
    exec(process.execPath, [path.join(example, "run.mjs"), outageConfig, prompt], {
      cwd: workspace,
      env: { ...env, COREMIND_ONTOLOGY_AUTHORIZATION: auth },
      encoding: "utf8",
      timeout: 30_000,
    }),
  );
  assert.equal(active.turns, 0);
  console.log(JSON.stringify({ case: "transport_offline", modelRequests: active.turns }));
  service = undefined;

  const broken = path.join(workspace, "broken-model");
  await cp(bundle, broken, { recursive: true });
  await writeFile(path.join(broken, "model.ttl"), "invalid turtle fixture", "utf8");
  service = await startOntology(broken, fixture);
  await checkHealth(service, "unavailable");
  const disabledAction = await fetch(`${service.origin}/health`, {
    headers: { Authorization: actionAuth },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(disabledAction.status, 401);
  await runFour("model_unavailable", service, [describe, validate, inspect], (results) => {
    assert.deepEqual(
      results,
      Array(3).fill({ status: "unavailable", reason: "ontology_unavailable" }),
    );
  });
  await service.close();
  service = undefined;

  const missingReceipt = `
import os
import sys
from pathlib import Path
import uvicorn
sys.path.insert(0, sys.argv[1])
from ontology_project import OntologyProject
from ontology_server import make_app
project = OntologyProject(Path(sys.argv[2]), executor=lambda command: None)
read_token = os.environ["COREMIND_ONTOLOGY_AUTHORIZATION"].encode("utf-8")
action_token = os.environ["COREMIND_ONTOLOGY_ACTION_AUTHORIZATION"].encode("utf-8")
uvicorn.run(make_app(project, read_token, action_token), host="127.0.0.1", port=0, proxy_headers=False, access_log=False, use_colors=False)
`;
  service = await startLocalPython(["-B", "-X", "utf8", "-c", missingReceipt, example, bundle], {
    python,
    cwd: workspace,
    env: {
      ...env,
      COREMIND_ONTOLOGY_AUTHORIZATION: auth,
      COREMIND_ONTOLOGY_ACTION_AUTHORIZATION: actionAuth,
    },
  });
  const uncertain = await runAction(service, writeAuth, perform, "allow", "unknown");
  assert.equal(uncertain.reason, "effect_not_confirmed");
  const newRequest = { ...perform, args: { ...perform.args, request_id: "after-unknown" } };
  assert.equal(
    (await runAction(service, writeAuth, newRequest, "allow", "denied")).reason,
    "prior_effect_unknown",
  );
  console.log(
    JSON.stringify({ case: "missing_business_receipt", outcomes: ["unknown", "denied"] }),
  );
} finally {
  if (service) await service.close();
  provider.closeAllConnections();
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
