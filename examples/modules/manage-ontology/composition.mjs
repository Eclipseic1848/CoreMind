import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatSession, CoreMindRuntime, parseAndValidate } from "coremind-ai";
import { startLocalPython, startOntology } from "./ontology-fixture.mjs";

const example = import.meta.dirname;
const workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-composition-"));
const python = process.env.COREMIND_ONTOLOGY_PYTHON ?? "python";
const tokens = {
  KNOWLEDGE_READ: "Bearer composition-knowledge-fixture",
  MEMORY_READ: "Bearer composition-memory-read-fixture",
  MEMORY_ADMIN: "Bearer composition-memory-admin-fixture",
  ONTOLOGY_READ: "Bearer composition-ontology-fixture",
};
const childEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  PYTHONIOENCODING: "utf-8",
  ...tokens,
};

// 复用业务服务的目录、版本与授权。检索后端使用确定性关键词和内存记录。
const adapter = String.raw`
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import uvicorn

kind, ontology_home, changed = sys.argv[1:]
sys.path.insert(0, str(Path(ontology_home).with_name(f"manage-{kind}")))

if kind == "knowledge":
    # 生产服务入口用 Qdrant；联合用例复用相同服务装配，使用确定性的索引替身。
    class KeywordIndex:
        def replace(self, chunks):
            self.chunks = chunks

        def search(self, query, *, scope, as_of, limit, mode):
            return [row for row in self.chunks if query in row["text"]
                    and row["access"] in {scope, "public"}
                    and row["validFrom"] <= as_of
                    and (row["validUntil"] is None or as_of < row["validUntil"])][:limit]

    sys.modules["qdrant_retrieval"] = SimpleNamespace(KnowledgeIndex=KeywordIndex)
    from knowledge_catalog import KnowledgeCatalog
    from knowledge_server import load_corpus, make_app

    catalog = KnowledgeCatalog(KeywordIndex(), Path("knowledge-state.json"))
    sources = Path("sources")
    sources.mkdir(exist_ok=True)
    documents = []
    for doc_id, version, title, entries in (
        ("guide", 1, "资料室手册", ["来访登记"]),
        ("guide", 2, "资料室手册", ["来访登记", "归还后核销"]),
        ("draft", 1, "新制度草稿", ["本周新增档案交接登记"]),
    ):
        filename = f"{doc_id}-v{version}.md"
        (sources / filename).write_text(f"# 资料摘录\n{title}｜{'；'.join(entries)}\n", encoding="utf-8")
        documents.append({
            "id": doc_id, "version": version, "file": filename,
            "access": "public", "validFrom": "2020-01-01", "validUntil": None,
        })
    manifest = Path("corpus.json")
    manifest.write_text(json.dumps({"asOf": "2026-01-01", "documents": documents}), encoding="utf-8")
    as_of, records = load_corpus(manifest)
    catalog.import_documents(records)
    if changed:
        catalog.withdraw("guide", 2)
    app = make_app(catalog, "public", as_of, os.environ["KNOWLEDGE_READ"].encode("utf-8"))
else:
    from memory_server import Bindings, MemoryService, make_app

    class ExactMemory:
        def __init__(self):
            self.rows = {}

        def ensure_bank(self, _bank):
            pass

        def retain(self, bank, doc, text, *, source, version, **_):
            self.rows[bank, doc] = {"documentId": doc, "text": text, "source": source, "version": version}

        def recall(self, bank, query, *, allowed_document_ids):
            return [row for (scope, doc), row in self.rows.items()
                    if scope == bank and doc in allowed_document_ids and query in row["text"]]

    rules = Bindings.model_validate({
        "banks": {"editor": {"kind": "personal"}},
        "readers": [{"tokenEnv": "MEMORY_READ", "banks": ["editor"]}],
        "administrators": [{"tokenEnv": "MEMORY_ADMIN", "banks": ["editor"]}],
    })
    app = make_app(MemoryService(ExactMemory(), Path("memory-state.json")), rules)

uvicorn.run(app, host="127.0.0.1", port=0, proxy_headers=False, access_log=False, use_colors=False)
`;

const skillId = "document-comparison";
const skillBody =
  "# 资料版本对照\n\n比较同一资料的两个版本，逐项附文件、版本和行号。依照已确认偏好撰写表格或清单。只有一版时说明缺少可对照的版本。\n";
const skillPath = path.join(workspace, "skills", skillId);
const startAdapter = (kind, changed = "") =>
  startLocalPython(["-B", "-X", "utf8", "-c", adapter, kind, example, changed], {
    python,
    cwd: workspace,
    env: childEnv,
  });

const mcp = (server, tool) => ({
  mcp: { server, tool },
  effect: { operations: ["network"], reversible: true },
  capability: {
    effect: "network",
    replay: "safe",
    concurrency: "run_serial",
    checkpoint: "none",
    durability: "critical",
  },
});
const forServer = (service, token) => ({
  transport: "streamable-http",
  url: `${service.origin}/mcp`,
  allowedAddresses: ["127.0.0.1"],
  headers: { Authorization: { env: token } },
});

function compose({ title, compare }, [lookup, recall, skill, action]) {
  assert.ok(skill.includes(skillBody.trim()), "需从真实 Skill 工具载入方法");
  const citations = JSON.parse(lookup).citations.sort(
    (left, right) => right.version - left.version,
  );
  const [current, prior] = citations;
  assert.ok(current && citations.every(({ text }) => text.startsWith(`${title}｜`)));
  const memory = JSON.parse(recall).memories[0] ?? null;
  const entries = ({ text }) => text.split("｜")[1].split("；");
  const present = entries(current);
  const old = prior ? entries(prior) : [];
  const items = compare && !prior ? [] : present.filter((entry) => !old.includes(entry));
  const cite = ({ file, version, line }) => `${file}（版本 ${version}，第 ${line} 行）`;
  const lines = [`# ${title}`, ""];
  if (!items.length) lines.push("- 缺少可对照的版本，无法核实新增条目。");
  else if (memory?.text.includes("表格"))
    lines.push(
      "| 条目 | 出处 |",
      "| --- | --- |",
      ...items.map((entry) => `| ${entry} | ${cite(current)} |`),
    );
  else lines.push(...items.map((entry) => `- ${entry}（${cite(current)}）`));
  const gate = action ? JSON.parse(action) : null;
  if (gate?.status === "denied") lines.push("", "发布条件未满足，保留草稿。");
  return { citations: citations.map(cite), memory, gate, markdown: `${lines.join("\n")}\n` };
}

const textOf = ({ content }) =>
  typeof content === "string" ? content : content.map(({ text }) => text).join("");
let active;
const provider = createServer(async (request, response) => {
  const task = active;
  try {
    assert.equal(request.url, "/v1/chat/completions");
    request.setEncoding("utf8");
    let body = "";
    for await (const chunk of request) body += chunk;
    for (const token of Object.values(tokens)) assert.ok(!body.includes(token));
    const { messages, tools } = JSON.parse(body);
    const users = messages.filter(({ role }) => role === "user").map(textOf);
    assert.deepEqual(users, [task.prompt], "新会话继承了上一会话消息");
    const available = tools.map(({ function: tool }) => tool);
    assert.equal(
      available.some(({ description }) => description.includes("ontology_inspect_action")),
      task.ontology,
    );
    assert.ok(
      !available.some(({ description }) => description.includes("ontology_perform_action")),
    );
    const returned = messages.filter(({ role }) => role === "tool").map(textOf);
    const step = task.turns++;
    assert.equal(returned.length, step);
    let next = task.calls[step];
    if (step === task.calls.length) {
      task.output = compose(task, returned);
      next = ["write", { path: task.file, content: task.output.markdown }];
    }
    let delta = { content: JSON.stringify(task.output) };
    if (next) {
      const [name, args] = next;
      const matches = available.filter(
        (tool) => tool.name === name || tool.description.endsWith(` / ${name}）`),
      );
      assert.equal(matches.length, 1, `缺少工具 ${name}`);
      delta = {
        tool_calls: [
          {
            index: 0,
            id: `composition-${step}`,
            type: "function",
            function: {
              name: matches[0].name,
              arguments: JSON.stringify(args),
            },
          },
        ],
      };
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const choice of [
      { delta: { role: "assistant", ...delta }, finish_reason: null },
      { delta: {}, finish_reason: next ? "tool_calls" : "stop" },
    ])
      response.write(
        `data: ${JSON.stringify({ id: `composition-${step}`, choices: [{ index: 0, ...choice }] })}\n\n`,
      );
    response.end("data: [DONE]\n\n");
  } catch (error) {
    task.error = error;
    response.writeHead(500).end();
  }
});

let knowledge, memory, ontology, closed;
async function runSession(id, title, compare, withOntology) {
  const calls = [
    ["search_knowledge", { query: title }],
    ["recall_memory", { query: "资料摘要" }],
    ["load_skill", { id: skillId }],
  ];
  const servers = {
    knowledge: forServer(knowledge, "KNOWLEDGE_READ"),
    memory: forServer(memory, "MEMORY_READ"),
  };
  const tools = [
    mcp("knowledge", "search_knowledge"),
    mcp("memory", "recall_memory"),
    { id: "write" },
  ];
  if (withOntology) {
    servers.ontology = forServer(ontology, "ONTOLOGY_READ");
    tools.push(mcp("ontology", "ontology_inspect_action"));
    calls.push(["ontology_inspect_action", { action: "publish", resource: "urn:doc:draft" }]);
  }
  const { config } = parseAndValidate({
    schemaVersion: 3,
    name: "资料整理联合验收",
    provider: {
      id: "local-composition",
      model: "fixture",
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    },
    defaultAgent: "main",
    mcp: { servers },
    agents: { main: { tools, skills: [skillId] } },
    permissions: {
      mode: "ask",
      allow: ["load_skill", "write"],
      network: "allow",
      workspaceOnly: true,
    },
    session: { enabled: true, compact: false },
    runtime: { maxTurns: 8, maxToolCalls: 14, maxRetries: 0, runTimeoutMs: 20_000 },
  });
  const file = `${id}.md`;
  const prompt = compare
    ? `找出《${title}》本版本新增的条目并附出处。`
    : `整理《${title}》并附出处，核对发布条件。`;
  const task = { title, compare, ontology: withOntology, prompt, file, calls, turns: 0 };
  active = task;
  const env = {
    KNOWLEDGE_READ: tokens.KNOWLEDGE_READ,
    MEMORY_READ: tokens.MEMORY_READ,
    ONTOLOGY_READ: tokens.ONTOLOGY_READ,
  };
  const runtime = await CoreMindRuntime.create({
    config,
    configDir: workspace,
    cwd: workspace,
    sessionId: id,
    env,
    approveTool: async ({ args }) => (args.path === file ? "allow" : "deny"),
  });
  const chat = new ChatSession(runtime, "main");
  const { run } = await chat.chat(prompt);
  if (task.error) throw task.error;
  assert.equal(run.outcome.status, "succeeded", JSON.stringify(run.outcome));
  assert.equal(task.turns, calls.length + 2);
  assert.equal((await chat.inspectSessionTree()).sessionId, id);
  const output = JSON.parse(run.transcript);
  assert.equal(await readFile(path.join(workspace, file), "utf8"), output.markdown);
  return output;
}

async function confirmPreference(expectedVersion, text, session) {
  const action = expectedVersion ? "correct" : "retain";
  const response = await fetch(`${memory.origin}/admin/${action}`, {
    method: "POST",
    headers: { Authorization: tokens.MEMORY_ADMIN, "content-type": "application/json" },
    body: JSON.stringify({
      bankId: "editor",
      documentId: "summary-format",
      expectedVersion,
      text,
      source: `session:${session}:confirmed`,
      occurredAt: "2026-01-01",
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "active",
    documentId: "summary-format",
    version: expectedVersion + 1,
  });
}

try {
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, "SKILL.md"),
    `---\nname: ${skillId}\ndescription: 整理资料或比较资料新增条目并标注出处。\n---\n\n${skillBody}`,
    "utf8",
  );
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  knowledge = await startAdapter("knowledge");
  memory = await startAdapter("memory");
  ontology = await startOntology(path.join(example, "models", "document-review"), {
    python,
    cwd: workspace,
    env: childEnv,
    readToken: tokens.ONTOLOGY_READ,
  });

  const first = await runSession("comparison", "资料室手册", true, false);
  assert.equal(first.memory, null);
  assert.deepEqual(first.citations, [
    "guide-v2.md（版本 2，第 2 行）",
    "guide-v1.md（版本 1，第 2 行）",
  ]);
  assert.match(first.markdown, /- 归还后核销/u);
  assert.doesNotMatch(first.markdown, /来访登记/u);
  await confirmPreference(0, "资料摘要优先使用表格", "comparison");

  const second = await runSession("draft-review", "新制度草稿", false, true);
  assert.deepEqual(second.citations, ["draft-v1.md（版本 1，第 2 行）"]);
  assert.equal(second.memory.version, 1);
  assert.equal(second.memory.source.ref, "session:comparison:confirmed");
  assert.match(second.markdown, /\| 本周新增档案交接登记 \|/u);
  assert.equal(second.gate.status, "denied");
  assert.equal(second.gate.reason, "precondition_failed");
  await confirmPreference(1, "资料摘要优先使用清单", "draft-review");

  await knowledge.close();
  knowledge = await startAdapter("knowledge", "withdraw");
  const third = await runSession("after-correction", "资料室手册", true, false);
  assert.equal(third.memory.version, 2);
  assert.equal(third.memory.text, "资料摘要优先使用清单");
  assert.deepEqual(third.citations, ["guide-v1.md（版本 1，第 2 行）"]);
  assert.match(third.markdown, /缺少可对照的版本/u);
  assert.doesNotMatch(third.markdown, /guide-v2|归还后核销/u);
  console.log(JSON.stringify({ sessions: [first, second, third], artifactsVerified: 3 }));
} finally {
  closed = await Promise.allSettled([knowledge?.close(), memory?.close(), ontology?.close()]);
  if (provider.listening) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  assert.equal(path.dirname(workspace), await realpath(tmpdir()));
  assert.match(path.basename(workspace), /^coremind-composition-/u);
  await rm(workspace, { recursive: true, force: true });
}
for (const result of closed) if (result.status === "rejected") throw result.reason;
