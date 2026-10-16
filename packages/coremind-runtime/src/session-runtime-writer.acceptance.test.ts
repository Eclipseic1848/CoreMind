import "../../../test/setup-env.js";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreMindConfig } from "coremind-config";
import { describe, expect, it, type TestContext, vi } from "vitest";
import { ChatSession } from "./chat-session.js";
import type { CoreMindMessage } from "./public-message.js";
import { CoreMindRuntime, type RunResult } from "./runtime.js";
import { CoreMindSession } from "./session.js";
import { SessionFileSystem } from "./session-v4/file-system.js";

type WireRequest = { messages: Array<{ role: string; content?: unknown }> };
type Fixture = {
  directory: string;
  baseUrl: string;
  children: Set<OwnedChild>;
  requests: WireRequest[];
  make(prompt?: string): Promise<CoreMindRuntime>;
  run(runtime: CoreMindRuntime): Promise<RunResult>;
  chat(chat: ChatSession, prompt: string): ReturnType<ChatSession["chat"]>;
  turn(runtime: CoreMindRuntime, prompt: string, history: CoreMindMessage[]): Promise<RunResult>;
  session(): Promise<CoreMindSession>;
  bytes(): Promise<string>;
  hold(): void;
  entered: Promise<void>;
  release(): void;
};

describe("持久 Session 的真实 Runtime 单写者合同", () => {
  it("首个 Runtime 等待 HTTP 时，另一个 Runtime 在任何新 HTTP 前拒绝", async (context) => {
    await withFixture(context, async (f) => {
      const first = await f.make("先运行");
      const second = await f.make("并发不得发送");
      f.hold();
      const running = f.run(first);
      await bounded(f.entered);
      expect(f.requests).toHaveLength(1);
      await expect(bounded(f.run(second))).rejects.toMatchObject({ code: "session_write_locked" });
      expect(f.requests).toHaveLength(1);
      f.release();
      expect((await bounded(running)).outcome.status).toBe("succeeded");
      await assertSession(f, ["先运行", "回答-1"]);
    });
  });

  it("create 后外部追加，普通 run 使用权威新历史且只追加本轮", async (context) => {
    await withFixture(context, async (f) => {
      await (await f.session()).appendMessages([
        { role: "user", content: "创建前历史", timestamp: 1 },
      ]);
      const runtime = await f.make("本轮问题");
      await (await f.session()).appendMessages([
        { role: "user", content: "创建后外部追加", timestamp: 2 },
      ]);
      expect((await bounded(f.run(runtime))).outcome.status).toBe("succeeded");
      expect(f.requests).toHaveLength(1);
      expect(conversation(f.requests[0]!)).toEqual(["创建前历史", "创建后外部追加", "本轮问题"]);
      await assertSession(f, ["创建前历史", "创建后外部追加", "本轮问题", "回答-1"]);
      const chat = new ChatSession(runtime, "main");
      expect((await bounded(f.chat(chat, "新视图"))).run.outcome.status).toBe("succeeded");
      expect(conversation(f.requests[1]!)).toEqual([
        "创建前历史",
        "创建后外部追加",
        "本轮问题",
        "回答-1",
        "新视图",
      ]);
      await assertSession(f, [
        "创建前历史",
        "创建后外部追加",
        "本轮问题",
        "回答-1",
        "新视图",
        "回答-2",
      ]);
    });
  });

  it("同 Runtime 的旧 Chat 视图拒绝，Session 字节和 HTTP 均不推进", async (context) => {
    await withFixture(context, async (f) => {
      const runtime = await f.make();
      const first = new ChatSession(runtime, "main");
      const stale = new ChatSession(runtime, "main");
      expect((await bounded(f.chat(first, "第一个视图"))).run.outcome.status).toBe("succeeded");
      const confirmed = await f.bytes();
      await expect(bounded(f.chat(stale, "旧视图不得发送"))).rejects.toMatchObject({
        code: "session_snapshot_stale",
      });
      expect(f.requests).toHaveLength(1);
      expect(await f.bytes()).toBe(confirmed);
      await assertSession(f, ["第一个视图", "回答-1"]);
      const fresh = new ChatSession(runtime, "main");
      expect((await bounded(f.chat(fresh, "重建视图"))).run.outcome.status).toBe("succeeded");
      expect(conversation(f.requests[1]!)).toEqual(["第一个视图", "回答-1", "重建视图"]);
      await assertSession(f, ["第一个视图", "回答-1", "重建视图", "回答-2"]);
    });
  });

  it("同 Chat 两轮传递新水位，wire 历史和持久消息均恰好一次", async (context) => {
    await withFixture(context, async (f) => {
      const chat = new ChatSession(await f.make(), "main");
      const first = await bounded(f.chat(chat, "第一问"));
      const second = await bounded(f.chat(chat, "第二问"));
      expect([first.run.outcome.status, second.run.outcome.status]).toEqual([
        "succeeded",
        "succeeded",
      ]);
      expect([first.text, second.text]).toEqual(["回答-1", "回答-2"]);
      expect(first.run.runId).not.toBe(second.run.runId);
      expect(f.requests).toHaveLength(2);
      expect(conversation(f.requests[0]!)).toEqual(["第一问"]);
      expect(conversation(f.requests[1]!)).toEqual(["第一问", "回答-1", "第二问"]);
      await assertSession(f, ["第一问", "回答-1", "第二问", "回答-2"]);
    });
  });
  it("宿主浅复制上一轮消息可继续，复制旧历史仍在 HTTP 前拒绝", async (context) => {
    await withFixture(context, async (f) => {
      const runtime = await f.make();
      const first = await bounded(f.turn(runtime, "第一问", runtime.initialMessagesFor("main")));
      const copied = [...first.messages.get("main")!];
      const second = await bounded(f.turn(runtime, "第二问", copied));
      expect([first.outcome.status, second.outcome.status]).toEqual(["succeeded", "succeeded"]);
      expect(conversation(f.requests[1]!)).toEqual(["第一问", "回答-1", "第二问"]);
      await expect(
        bounded(f.turn(runtime, "旧副本", [...first.messages.get("main")!])),
      ).rejects.toMatchObject({ code: "session_snapshot_stale" });
      expect(f.requests).toHaveLength(2);
      await assertSession(f, ["第一问", "回答-1", "第二问", "回答-2"]);
    });
  });

  it("真实两个进程在 HTTP 前互斥，原忙进程重试读取新历史", async (context) => {
    await withFixture(context, async (f) => {
      const runtimeModule = fileURLToPath(new URL("../dist/runtime.js", import.meta.url));
      const first = startChild(f, "session-runtime-writer-process.mjs", runtimeModule, "进程-A");
      const second = startChild(f, "session-runtime-writer-process.mjs", runtimeModule, "进程-B");
      try {
        const ready = await Promise.all([
          childMessage(first, "ready"),
          childMessage(second, "ready"),
        ]);
        expect(ready.map((message) => message.pid)).toEqual([first.child.pid, second.child.pid]);
        expect(first.child.pid).not.toBe(second.child.pid);
        f.hold();
        await childCommand(first, "go");
        await bounded(f.entered);
        expect(f.requests).toHaveLength(1);
        await childCommand(second, "go");
        expect(await childMessage(second, "done", 1)).toMatchObject({
          rejected: true,
          code: "session_write_locked",
        });
        expect(f.requests).toHaveLength(1);
        f.release();
        expect(await childMessage(first, "done", 1)).toMatchObject({ status: "succeeded" });
        await childCommand(second, "go");
        expect(await childMessage(second, "done", 2)).toMatchObject({ status: "succeeded" });
        expect(f.requests).toHaveLength(2);
        expect(conversation(f.requests[0]!)).toEqual(["进程-A"]);
        expect(conversation(f.requests[1]!)).toEqual(["进程-A", "回答-1", "进程-B"]);
        const exited = await Promise.all([stopChild(first), stopChild(second)]);
        expect(exited).toEqual([
          { code: 0, signal: null, exited: true },
          { code: 0, signal: null, exited: true },
        ]);
        for (const child of [first, second]) {
          expect(child.messages).toContainEqual(
            expect.objectContaining({ type: "closed", quiescent: true }),
          );
        }
        await assertSession(f, ["进程-A", "回答-1", "进程-B", "回答-2"]);
      } finally {
        f.release();
        await stopChildren(f.children);
      }
    });
  });

  it("真实进程同时持 write/open 锁后被终止，两类死主均可安全回收", async (context) => {
    await withFixture(context, async (f) => {
      await (await f.session()).appendMessages([
        { role: "user", content: "崩溃前历史", timestamp: 1 },
      ]);
      const runtime = await f.make("崩溃后接续");
      const leaseModule = fileURLToPath(new URL("../dist/session-write-lease.js", import.meta.url));
      const child = startChild(f, "session-writer-crash-process.mjs", leaseModule);
      const publicPath = path.join(f.directory, "sessions", "shared.jsonl");
      const lockPaths = [`${publicPath}.write.lock`, `${publicPath}.open.lock`];
      try {
        const locked = await childMessage(child, "locked");
        expect(locked.pid).toBe(child.child.pid);
        const originals = await Promise.all(
          lockPaths.map((filename) => readFile(filename, "utf8")),
        );
        for (const [index, source] of originals.entries()) {
          expect(JSON.parse(source)).toMatchObject({
            schemaVersion: 1,
            kind: index === 0 ? "write" : "open",
            pid: child.child.pid,
            sessionPath: locked.sessionPath,
          });
        }
        expect(child.child.kill("SIGKILL")).toBe(true);
        expect((await bounded(child.closed, 2_000)).exited).toBe(true);
        expect(() => process.kill(locked.pid!, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" }),
        );
        expect(await Promise.all(lockPaths.map((filename) => readFile(filename, "utf8")))).toEqual(
          originals,
        );
        expect((await bounded(f.run(runtime))).outcome.status).toBe("succeeded");
        expect(f.requests).toHaveLength(1);
        expect(conversation(f.requests[0]!)).toEqual(["崩溃前历史", "崩溃后接续"]);
        await assertSession(f, ["崩溃前历史", "崩溃后接续", "回答-1"]);
        expect(await f.bytes()).toContain("崩溃后接续");
        for (const filename of lockPaths) {
          await expect(readFile(filename, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await stopChildren(f.children);
      }
    });
  });
  for (const cancel of [false, true]) {
    it(`最终 Session 追加屏障覆盖运行收尾（取消=${cancel}）`, async (context) => {
      await withFixture(context, async (f) => {
        const marker = cancel ? "取消期间唯一输入" : "正常追加唯一输入";
        const runtime = await f.make();
        const competing = await f.make("屏障期间不得发送");
        const chat = new ChatSession(runtime, "main");
        const entered = deferred();
        const release = deferred();
        const append = SessionFileSystem.prototype.appendFile;
        let blocked = false;
        let settled = false;
        let running: ReturnType<ChatSession["chat"]> | undefined;
        const spy = vi
          .spyOn(SessionFileSystem.prototype, "appendFile")
          .mockImplementation(async function (this: SessionFileSystem, filename, content) {
            const text =
              typeof content === "string" ? content : Buffer.from(content).toString("utf8");
            if (!blocked && text.includes(marker)) {
              blocked = true;
              entered.resolve();
              await release.promise;
            }
            return append.call(this, filename, content);
          });
        try {
          if (cancel) f.hold();
          running = f.chat(chat, marker);
          void running.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          if (cancel) {
            await bounded(f.entered);
            chat.abort();
          }
          await bounded(entered.promise);
          expect(f.requests).toHaveLength(1);
          expect(settled).toBe(false);
          await expect(bounded(f.run(competing))).rejects.toMatchObject({
            code: "session_write_locked",
          });
          expect(f.requests).toHaveLength(1);
          expect(settled).toBe(false);
          release.resolve();
          expect((await bounded(running)).run.outcome.status).toBe(
            cancel ? "aborted" : "succeeded",
          );
          expect(await bounded(runtime.waitForQuiescence())).toBe(true);
          expect((await bounded(f.run(await f.make("收敛后接续")))).outcome.status).toBe(
            "succeeded",
          );
          const confirmed = cancel ? [marker] : [marker, "回答-1"];
          expect(f.requests).toHaveLength(2);
          expect(conversation(f.requests[1]!)).toEqual([...confirmed, "收敛后接续"]);
          await assertSession(f, [...confirmed, "收敛后接续", "回答-2"]);
        } finally {
          release.resolve();
          chat.abort();
          if (running) await bounded(running, 2_000).catch(() => undefined);
          spy.mockRestore();
          f.release();
        }
      });
    });
  }
});

async function withFixture(context: TestContext, action: (fixture: Fixture) => Promise<void>) {
  const controller = new AbortController();
  const pending: Promise<unknown>[] = [];
  const runtimes = new Set<CoreMindRuntime>();
  const chats = new Set<ChatSession>();
  const children = new Set<OwnedChild>();
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  const entered = deferred();
  let directory = "";
  let holding = false;
  let held: { response: ServerResponse; ordinal: number } | undefined;
  let body: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const own = <T>(promise: Promise<T>) => {
    pending.push(promise);
    void promise.catch(() => undefined);
    return promise;
  };
  const server = createServer((request, response) => {
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      text += chunk;
    });
    request.on("end", () => {
      try {
        requests.push(JSON.parse(text) as WireRequest);
        const ordinal = requests.length;
        entered.resolve();
        if (holding) {
          holding = false;
          held = { response, ordinal };
        } else send(response, ordinal);
      } catch (error) {
        errors.push(error);
        response.writeHead(500).end();
      }
    });
  });
  const cancel = () => {
    controller.abort();
    for (const chat of chats) chat.abort();
    held?.response.destroy();
    for (const owner of children) {
      if (!owner.didClose) {
        try {
          owner.child.kill("SIGKILL");
        } catch (error) {
          errors.push(error);
        }
      }
    }
  };
  const close = () =>
    (closing ??= (async () => {
      cancel();
      await body?.catch(() => undefined);
      await stopChildren(children).catch((error) => errors.push(error));
      await bounded(Promise.allSettled(pending));
      for (const runtime of runtimes) expect(await bounded(runtime.waitForQuiescence())).toBe(true);
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      if ([...children].some((owner) => !owner.didClose)) {
        throw new AggregateError(errors, "自有会话子进程尚未实际退出，保留夹具目录");
      }
      if (directory) {
        expect(path.dirname(path.resolve(directory))).toBe(path.resolve(tmpdir()));
        expect(path.basename(directory).startsWith("coremind-session-writer-")).toBe(true);
        await rm(directory, { recursive: true, force: true });
      }
      expect(errors).toEqual([]);
      context.signal.removeEventListener("abort", cancel);
    })());
  context.signal.addEventListener("abort", cancel, { once: true });
  context.onTestFinished(close);
  if (context.signal.aborted) cancel();
  body = (async () => {
    directory = await mkdtemp(path.join(tmpdir(), "coremind-session-writer-"));
    controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    controller.signal.throwIfAborted();
    const session = () =>
      CoreMindSession.open({
        dir: path.join(directory, "sessions"),
        sessionId: "shared",
        cwd: directory,
      });
    const config: CoreMindConfig = {
      schemaVersion: 2,
      name: "会话写入验收",
      provider: {
        id: "probe",
        model: "probe-model",
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        apiKeyEnv: "COREMIND_TEST_API_KEY",
      },
      agents: { main: { tools: [] } },
      session: { enabled: true, compact: false },
      runtime: { maxTurns: 2, maxRetries: 0, runTimeoutMs: 6_000 },
    };
    await action({
      directory,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      children,
      requests,
      session,
      entered: entered.promise,
      bytes: () => readFile(path.join(directory, "sessions", "shared.jsonl"), "utf8"),
      make: async (initialPrompt) => {
        const runtime = await CoreMindRuntime.create({
          config,
          configDir: directory,
          cwd: directory,
          sessionId: "shared",
          initialPrompt,
          signal: controller.signal,
        });
        runtimes.add(runtime);
        return runtime;
      },
      run: (runtime) => own(runtime.run()),
      chat: (chat, prompt) => {
        chats.add(chat);
        return own(chat.chat(prompt));
      },
      turn: (runtime, prompt, history) =>
        own(runtime.runAgentTurn("main", prompt, history, () => {}, controller.signal)),
      hold: () => {
        holding = true;
      },
      release: () => {
        if (held) {
          send(held.response, held.ordinal);
          held = undefined;
        }
      },
    });
  })();
  try {
    await body;
  } finally {
    await close();
  }
}

async function assertSession(fixture: Fixture, expected: string[]) {
  const session = await fixture.session();
  const entries = await session.branchEntries();
  expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
  for (const [index, entry] of entries.entries())
    expect(entry.parentId).toBe(entries[index - 1]?.id ?? null);
  expect(
    (await session.buildContext()).messages.map((message) =>
      textOf("content" in message ? message.content : undefined),
    ),
  ).toEqual(expected);
}

function conversation(request: WireRequest): string[] {
  return request.messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => textOf(message.content));
}
function textOf(value: unknown): string {
  return typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
      : "";
}
function send(response: ServerResponse, ordinal: number) {
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: `回答-${ordinal}` }, null],
    [{}, "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: `session-${ordinal}`, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("会话验收阶段超时")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
interface ChildReply {
  type: string;
  pid?: number;
  attempt?: number;
  status?: string;
  rejected?: boolean;
  code?: string;
  quiescent?: boolean;
  sessionPath?: string;
}
interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  exited: boolean;
}
interface OwnedChild {
  child: ChildProcess;
  messages: ChildReply[];
  closed: Promise<ChildExit>;
  didClose: boolean;
  didExit: boolean;
  failure?: Error;
  stderr: string;
}

function startChild(
  fixture: Fixture,
  filename: string,
  modulePath: string,
  label = "",
): OwnedChild {
  const env: NodeJS.ProcessEnv = { COREMIND_TEST_API_KEY: "test-only" };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL(`../../../test/fixtures/${filename}`, import.meta.url)),
      modulePath,
      fixture.directory,
      fixture.baseUrl,
      label,
    ],
    {
      cwd: fixture.directory,
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const owner: OwnedChild = {
    child,
    messages: [],
    didClose: false,
    didExit: false,
    stderr: "",
    closed: undefined as unknown as Promise<ChildExit>,
  };
  fixture.children.add(owner);
  owner.closed = new Promise((resolve) => {
    child.once("exit", () => {
      owner.didExit = true;
    });
    child.once("close", (code, signal) => {
      owner.didClose = true;
      resolve({ code, signal, exited: owner.didExit });
    });
  });
  child.on("message", (message) => {
    const reply = message as ChildReply;
    owner.messages.push(reply);
    if (reply.type === "setup_error" || reply.type === "error") {
      owner.failure = new Error(`会话子进程报告错误：${reply.code ?? "unknown"}`);
    }
  });
  child.on("error", (error) => {
    owner.failure = error;
  });
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    owner.stderr = (owner.stderr + chunk).slice(-8_000);
  });
  return owner;
}

async function childMessage(
  owner: OwnedChild,
  type: string,
  attempt?: number,
): Promise<ChildReply> {
  let check!: () => void;
  const waiting = new Promise<ChildReply>((resolve, reject) => {
    check = () => {
      if (owner.failure) return reject(owner.failure);
      const reply = owner.messages.find(
        (message) =>
          message.type === type && (attempt === undefined || message.attempt === attempt),
      );
      if (reply) return resolve(reply);
      if (owner.didClose) reject(new Error(`会话子进程在回复 ${type} 前退出：${owner.stderr}`));
    };
    owner.child.on("message", check);
    owner.child.on("close", check);
    owner.child.on("error", check);
    check();
  });
  try {
    return await bounded(waiting);
  } finally {
    owner.child.off("message", check);
    owner.child.off("close", check);
    owner.child.off("error", check);
  }
}

async function childCommand(owner: OwnedChild, type: "go" | "stop") {
  await bounded(
    new Promise<void>((resolve, reject) => {
      owner.child.send({ type }, (error) => (error ? reject(error) : resolve()));
    }),
  );
}

async function stopChild(owner: OwnedChild): Promise<ChildExit> {
  if (owner.didClose) return owner.closed;
  try {
    if (owner.child.connected) owner.child.send({ type: "stop" }, () => undefined);
  } catch {
    owner.child.kill("SIGKILL");
  }
  try {
    return await bounded(owner.closed, 500);
  } catch {
    owner.child.kill("SIGKILL");
    return bounded(owner.closed, 1_500);
  }
}

async function stopChildren(children: Set<OwnedChild>) {
  const results = await Promise.allSettled([...children].map(stopChild));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) throw new AggregateError(failures, "会话子进程未在两秒内实际退出");
}
