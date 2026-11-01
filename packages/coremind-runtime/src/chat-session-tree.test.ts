import "../../../test/setup-env.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, type TestContext } from "vitest";
import { ChatSession } from "./chat-session.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";
import type { ChatSessionNodeRef, ChatSessionTree } from "./session-tree.js";
import { JsonlSessionRepo, SessionFileSystem } from "./session-v4/index.js";

type Wire = { messages: Array<{ role: string; content: unknown }> };

async function fixture(context: TestContext, readTool = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "coremind-session-tree-"));
  const requests: Wire[] = [];
  const chats: ChatSession[] = [];
  const pending: Promise<unknown>[] = [];
  const controller = new AbortController();
  let holding = false;
  let held: (() => void) | undefined;
  let entered = () => {};
  let enteredPromise = Promise.resolve();
  const send = (response: ServerResponse, ordinal: number) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (readTool && requests[ordinal - 1]!.messages.at(-1)?.role === "user") {
      response.write(
        `data: ${JSON.stringify({ id: `tool-${ordinal}`, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${ordinal}`, type: "function", function: { name: "read", arguments: '{"path":"notes.txt"}' } }] }, finish_reason: null }] })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({ id: `tool-${ordinal}`, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.write(
      `data: ${JSON.stringify({ id: `reply-${ordinal}`, choices: [{ index: 0, delta: { role: "assistant", content: `答-${ordinal}` }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ id: `reply-${ordinal}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as Wire);
      const ordinal = requests.length;
      if (holding) {
        holding = false;
        held = () => send(response, ordinal);
        entered();
      } else send(response, ordinal);
    });
  });
  const cancel = () => {
    controller.abort();
    for (const chat of chats) chat.abort();
    held?.();
    held = undefined;
  };
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(async () => {
    cancel();
    await Promise.allSettled(pending);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()));
    expect(path.basename(dir)).toMatch(/^coremind-session-tree-/u);
    await rm(dir, { recursive: true, force: true });
    context.signal.removeEventListener("abort", cancel);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config: CoreMindConfig = {
    schemaVersion: 2,
    name: "会话树验收",
    provider: {
      id: "probe",
      model: "probe-model",
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      apiKeyEnv: "COREMIND_TEST_API_KEY",
    },
    agents: { main: { tools: [] }, other: { tools: [] } },
    defaultAgent: "main",
    session: { enabled: true, compact: false },
    runtime: { maxTurns: 2, maxRetries: 0, runTimeoutMs: 6_000 },
  };
  if (readTool) {
    config.agents.main = { tools: [{ id: "read" }] };
    config.permissions = { mode: "ask", workspaceOnly: true, network: "ask" };
    await writeFile(path.join(dir, "notes.txt"), "审批控制的内容", "utf8");
  }
  const options = (sessionId = "source") => ({
    config,
    configDir: dir,
    cwd: dir,
    sessionId,
    signal: controller.signal,
  });
  const make = async (sessionId = "source") => {
    const runtime = await CoreMindRuntime.create(options(sessionId));
    const chat = new ChatSession(runtime, "main");
    chats.push(chat);
    return { runtime, chat };
  };
  const own = <T>(promise: Promise<T>) => {
    pending.push(promise);
    void promise.catch(() => {});
    return promise;
  };
  return {
    dir,
    config,
    options,
    make,
    requests,
    own,
    bytes: (id = "source") => readFile(path.join(dir, "sessions", `${id}.jsonl`), "utf8"),
    hold: () => {
      holding = true;
      enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      return enteredPromise;
    },
    release: () => {
      held?.();
      held = undefined;
    },
  };
}

function messageRef(tree: ChatSessionTree, content: string): ChatSessionNodeRef {
  const node = tree.nodes.find(
    (item) => item.message && JSON.stringify(item.message.content).includes(content),
  );
  expect(node).toBeDefined();
  return { sessionId: tree.sessionId, entryId: node!.id };
}

function conversation(wire: Wire): string[] {
  return wire.messages
    .filter((item) => item.role !== "system")
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : (item.content as Array<{ text: string }>).map((part) => part.text).join(""),
    );
}

describe("ChatSession 公共会话树", () => {
  it("分叉后的工具调用仍需新 Run 审批，来源会话的 allow 不授予后续权限", async (context) => {
    const f = await fixture(context, true);
    const sourceApprovals: string[] = [];
    const source = new ChatSession(
      await CoreMindRuntime.create({
        ...f.options(),
        approveTool: async (request) => {
          sourceApprovals.push(request.runId);
          return "allow";
        },
      }),
      "main",
    );
    const sourceTurn = await f.own(source.chat("读取文件"));
    expect(sourceTurn.run.outcome.status).toBe("succeeded");
    expect(sourceApprovals).toEqual([sourceTurn.run.runId]);
    const tree = await source.inspectSessionTree();
    const fork = await source.fork({
      sessionId: tree.sessionId,
      entryId: tree.branches[0]!.leafId!,
    });
    const targetApprovals: string[] = [];
    const target = new ChatSession(
      await CoreMindRuntime.create({
        ...f.options(fork.sessionId),
        approveTool: async (request) => {
          targetApprovals.push(request.runId);
          return "deny";
        },
      }),
      "main",
    );
    const rejected = await f.own(target.chat("再次读取文件"));
    expect(targetApprovals).toEqual([rejected.run.runId]);
    expect(rejected.run.runId).not.toBe(sourceTurn.run.runId);
    expect(rejected.run.outcome.status).toBe("paused");
    expect(rejected.run.trace.some((entry) => entry.event.type === "approval_required")).toBe(true);
    expect(f.requests).toHaveLength(3);
  });

  it("非主分支压缩和维护条目写到所选分支，fork 的历史视图仍可重建", async (context) => {
    const f = await fixture(context);
    const { chat } = await f.make();
    await f.own(chat.chat("保留主线"));
    const root = messageRef(await chat.inspectSessionTree(), "答-1");
    await chat.createBranch("compact", root);
    await chat.selectBranch("compact");
    const session = await CoreMindSession.open({
      dir: path.join(f.dir, "sessions"),
      cwd: f.dir,
      sessionId: "source",
    });
    const entries = await session.branchEntries();
    await session.appendCompaction({
      summary: "仅支线摘要",
      retainedTail: [],
      tokensBefore: 100,
      details: {
        fingerprint: "test-summary",
        rangeStartId: entries[0]!.id,
        rangeEndId: entries.at(-1)!.id,
      },
    });
    await session.appendMaintenanceRecord({ status: "测试维护" });
    const reopened = (await f.make()).chat;
    await f.own(reopened.chat("摘要后继续"));
    expect(conversation(f.requests[1]!)).toEqual(["仅支线摘要", "摘要后继续"]);
    const tree = await reopened.inspectSessionTree();
    const fork = await reopened.fork({
      sessionId: "source",
      entryId: tree.branches.find((branch) => branch.id === "compact")!.leafId!,
    });
    await f.own((await f.make(fork.sessionId)).chat.chat("分叉摘要继续"));
    expect(conversation(f.requests[2]!)).toEqual([
      "仅支线摘要",
      "摘要后继续",
      "答-2",
      "分叉摘要继续",
    ]);
    await reopened.selectBranch("main");
    await f.own(reopened.chat("主线不变"));
    expect(conversation(f.requests[3]!)).toEqual(["保留主线", "答-1", "主线不变"]);
  });
  it("分支读写隔离，选择和来源跨进程恢复，fork 不改变原会话", async (context) => {
    const f = await fixture(context);
    const { chat } = await f.make();
    await f.own(chat.chat("共同历史"));
    const root = messageRef(await chat.inspectSessionTree(), "答-1");
    await f.own(chat.chat("主分支私有"));
    await chat.createBranch("alternate", root);
    await chat.selectBranch("alternate");
    await f.own(chat.chat("支分支私有"));
    expect(conversation(f.requests[2]!)).toEqual(["共同历史", "答-1", "支分支私有"]);
    await chat.selectBranch("main");
    await f.own(chat.chat("返回主线"));
    expect(conversation(f.requests[3]!)).toEqual([
      "共同历史",
      "答-1",
      "主分支私有",
      "答-2",
      "返回主线",
    ]);
    await chat.selectBranch("alternate");
    const before = await f.bytes();
    const selected = await chat.inspectSessionTree();
    const at = messageRef(selected, "答-3");
    const fork = await chat.fork(at);
    expect(fork.sessionId).not.toBe("source");
    expect(fork.forkedFrom).toEqual(at);
    expect(fork.branches.map((branch) => branch.id)).toEqual(["main"]);
    expect(JSON.stringify(fork)).not.toContain("主分支私有");
    expect(await f.bytes()).toBe(before);
    const forkChat = (await f.make(fork.sessionId)).chat;
    const forkTurn = await f.own(forkChat.chat("分叉后继续"));
    expect(forkTurn.run.outcome.status).toBe("succeeded");
    expect(conversation(f.requests[4]!)).toEqual([
      "共同历史",
      "答-1",
      "支分支私有",
      "答-3",
      "分叉后继续",
    ]);
    expect(await f.bytes()).toBe(before);
    const input = path.join(f.dir, "reopen.json");
    await writeFile(
      input,
      JSON.stringify({ ...f.options(), signal: undefined, prompt: "重启继续" }),
      "utf8",
    );
    const child = await f.own(
      promisify(execFile)(
        process.execPath,
        [
          fileURLToPath(new URL("../../../test/fixtures/session-tree-reopen.mjs", import.meta.url)),
          input,
        ],
        { timeout: 10_000, encoding: "utf8" },
      ),
    );
    const reopened = JSON.parse(child.stdout) as { tree: ChatSessionTree; status: string };
    expect(reopened.tree.activeBranch).toBe("alternate");
    expect(reopened.status).toBe("succeeded");
    expect(conversation(f.requests[5]!)).toEqual([
      "共同历史",
      "答-1",
      "支分支私有",
      "答-3",
      "重启继续",
    ]);
    expect((await (await f.make(fork.sessionId)).chat.inspectSessionTree()).forkedFrom).toEqual(at);
  });

  it("未知或跨会话节点、重复和非法分支拒绝，DTO 修改不污染事实", async (context) => {
    const f = await fixture(context);
    const { chat } = await f.make();
    await f.own(chat.chat("消息节点"));
    const tree = await chat.inspectSessionTree();
    const node = messageRef(tree, "答-1");
    const before = await f.bytes();
    const invalid = [
      { ...node, sessionId: "foreign" },
      { ...node, sessionId: "../outside" },
      { ...node, entryId: "missing" },
    ];
    for (const at of invalid) {
      await expect(chat.fork(at)).rejects.toMatchObject({ code: "session_navigation_invalid" });
      await expect(chat.createBranch("candidate", at)).rejects.toMatchObject({
        code: "session_navigation_invalid",
      });
    }
    await expect(chat.selectBranch("missing")).rejects.toMatchObject({
      code: "session_navigation_invalid",
    });
    await expect(chat.createBranch("main", node)).rejects.toMatchObject({
      code: "session_navigation_invalid",
    });
    for (const id of ["", "../outside", "coremind/navigation/v1", "x".repeat(65)])
      await expect(chat.createBranch(id, node)).rejects.toMatchObject({
        code: "session_navigation_invalid",
      });
    tree.nodes[0]!.message!.content = "污染";
    tree.branches.length = 0;
    expect(await f.bytes()).toBe(before);
    expect(JSON.stringify(await chat.inspectSessionTree())).not.toContain("污染");
    await chat.createBranch("empty", null);
    await chat.selectBranch("empty");
    await f.own(chat.chat("空分支第一问"));
    expect(conversation(f.requests[1]!)).toEqual(["空分支第一问"]);
    const fork = await chat.fork(messageRef(await chat.inspectSessionTree(), "答-2"));
    await expect((await f.make(fork.sessionId)).chat.fork(node)).rejects.toMatchObject({
      code: "session_navigation_invalid",
    });
    await expect(CoreMindRuntime.create(f.options("../outside"))).rejects.toMatchObject({
      code: "session_restore_failed",
    });
  });

  it("活动 chat、同 Runtime 与另一个写入者均在任何导航写入前拒绝", async (context) => {
    const f = await fixture(context);
    const { runtime, chat } = await f.make();
    await f.own(chat.chat("种子"));
    const node = messageRef(await chat.inspectSessionTree(), "答-1");
    const second = (await f.make()).chat;
    const sameRuntime = new ChatSession(runtime, "main");
    const entered = f.hold();
    const running = f.own(chat.chat("阻塞中的轮次"));
    await entered;
    const before = await f.bytes();
    for (const other of [chat, sameRuntime]) {
      await expect(other.selectBranch("main")).rejects.toMatchObject({ code: "concurrent_run" });
      await expect(other.fork(node)).rejects.toMatchObject({ code: "concurrent_run" });
      await expect(other.createBranch("blocked", node)).rejects.toMatchObject({
        code: "concurrent_run",
      });
    }
    await expect(second.selectBranch("main")).rejects.toMatchObject({
      code: "session_write_locked",
    });
    await expect(second.fork(node)).rejects.toMatchObject({ code: "session_write_locked" });
    expect(await f.bytes()).toBe(before);
    expect(f.requests).toHaveLength(2);
    f.release();
    expect((await running).run.outcome.status).toBe("succeeded");
  });

  it("导航与 chat 互斥；旧快照不得通过切换分支覆盖新写入", async (context) => {
    const f = await fixture(context);
    const { chat, runtime } = await f.make();
    const stale = (await f.make()).chat;
    const navigation = chat.createBranch("new", null);
    await expect(chat.chat("导航未确认")).rejects.toMatchObject({ code: "concurrent_run" });
    await expect(runtime.run()).rejects.toMatchObject({ code: "concurrent_run" });
    await navigation;
    const before = await f.bytes();
    await expect(stale.selectBranch("new")).rejects.toMatchObject({
      code: "session_snapshot_stale",
    });
    await expect(stale.chat("旧视图")).rejects.toMatchObject({ code: "session_snapshot_stale" });
    expect(await f.bytes()).toBe(before);
    expect(f.requests).toHaveLength(0);
    await (await f.make()).chat.selectBranch("new");
  });

  it("fork 不复制 Run、队列和工具执行记录，且不能接收旧 Run 控制", async (context) => {
    const f = await fixture(context);
    const { chat } = await f.make();
    const turn = await f.own(chat.chat("可复制的对话"));
    const repo = new JsonlSessionRepo({
      fs: new SessionFileSystem({ cwd: f.dir }),
      sessionsRoot: path.join(f.dir, "sessions"),
    });
    const sourceMetadata = (await repo.list({ cwd: f.dir }))[0]!;
    const source = await repo.open(sourceMetadata);
    const entryId = (await source.getLeafId())!;
    await source.appendRecord({
      type: "operation_started",
      id: "old-run",
      lane: "main",
      sourceLeafId: entryId,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await source.appendRecord({
      type: "queue_enqueued",
      id: "old-input",
      lane: "main",
      queue: "steer",
      runId: "old-run",
      target: {
        type: "message",
        id: "unconsumed",
        message: { role: "user", content: "不得继承的控制", timestamp: 1 },
      },
    });
    await source.appendRecord({
      type: "tool_started",
      id: "old-effect",
      lane: "main",
      runId: "old-run",
      assistantEntryId: entryId,
      toolIndex: 0,
      toolCallId: "old-call",
      toolName: "write",
      effectiveArgs: { path: "never.txt" },
      resultEntryId: "old-result",
      replay: "never",
    });
    const reopened = (await f.make()).chat;
    const before = await f.bytes();
    const fork = await reopened.fork({ sessionId: "source", entryId });
    const forkMetadata = (await repo.list({ cwd: f.dir })).find(
      (item) => item.id === fork.sessionId,
    )!;
    expect(await (await repo.open(forkMetadata)).findRecords()).toEqual([]);
    const target = (await f.make(fork.sessionId)).chat;
    expect(await target.inspectCurrentRunProjection()).toBeUndefined();
    await expect(target.steer("旧控制", { runId: turn.run.runId })).rejects.toMatchObject({
      code: "control_unavailable",
    });
    const result = await f.own(target.chat("新执行"));
    expect(result.run.runId).not.toBe(turn.run.runId);
    expect(result.run.outcome.status).toBe("succeeded");
    expect(conversation(f.requests[1]!)).toEqual(["可复制的对话", "答-1", "新执行"]);
    expect(await f.bytes()).toBe(before);
    expect(
      await readFile(path.join(f.dir, "never.txt"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  });

  it("旧 v3 会话仍可打开再分支；禁用会话及非主 Agent 明确拒绝", async (context) => {
    const f = await fixture(context);
    const { runtime, chat } = await f.make();
    expect((await chat.inspectSessionTree()).activeBranch).toBe("main");
    await expect(new ChatSession(runtime, "other").inspectSessionTree()).rejects.toMatchObject({
      code: "session_navigation_invalid",
    });
    const disabled = await CoreMindRuntime.create({
      ...f.options(),
      config: { ...f.config, session: { enabled: false } },
    });
    await expect(new ChatSession(disabled, "main").inspectSessionTree()).rejects.toMatchObject({
      code: "session_navigation_invalid",
    });
    const header = {
      type: "session",
      version: 3,
      id: "legacy",
      timestamp: "2026-08-10T00:00:00.000Z",
      cwd: f.dir,
    };
    const entry = {
      type: "message",
      id: "legacy-message",
      parentId: null,
      timestamp: "2026-08-10T00:00:01.000Z",
      message: { role: "user", content: "旧会话历史", timestamp: 1 },
    };
    await writeFile(
      path.join(f.dir, "sessions", "legacy.jsonl"),
      `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`,
      "utf8",
    );
    const legacy = (await f.make("legacy")).chat;
    await legacy.createBranch("continuation", { sessionId: "legacy", entryId: "legacy-message" });
    await legacy.selectBranch("continuation");
    await f.own(legacy.chat("旧数据继续"));
    expect(conversation(f.requests[0]!)).toEqual(["旧会话历史", "旧数据继续"]);
    expect((await (await f.make("legacy")).chat.inspectSessionTree()).activeBranch).toBe(
      "continuation",
    );
  });
});
