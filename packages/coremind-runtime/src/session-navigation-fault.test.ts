import "../../../test/setup-env.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ kind: "", enabled: false, release: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (fault.release && String(args[0]).includes(".write.lock.released-")) {
        fault.release = false;
        throw Object.assign(new Error("注入导航租约释放失败"), { code: "EIO" });
      }
      return actual.rm(...args);
    },
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      const text = String(args[1]);
      if (fault.enabled && text.includes("coremind.session-branch.v1")) {
        fault.enabled = false;
        if (fault.kind === "partial") await actual.appendFile(args[0], text.slice(0, -2), "utf8");
        if (fault.kind === "ack") await actual.appendFile(...args);
        throw Object.assign(new Error("注入分支选择写入失败"), { code: "EIO" });
      }
      return actual.appendFile(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      const target = String(args[1]);
      if (
        fault.enabled &&
        fault.kind === "alias" &&
        target.endsWith(".jsonl") &&
        !target.endsWith("source.jsonl")
      ) {
        fault.enabled = false;
        throw Object.assign(new Error("注入分叉公开路径失败"), { code: "EIO" });
      }
      return actual.link(...args);
    },
  };
});

import { ChatSession } from "./chat-session.js";
import { CoreMindRuntime } from "./runtime.js";
import { CoreMindSession } from "./session.js";
import { JsonlSessionRepo, SessionFileSystem } from "./session-v4/index.js";

afterEach(() => {
  fault.enabled = false;
  fault.kind = "";
  fault.release = false;
});

async function fixture(context: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "coremind-navigation-fault-"));
  context.onTestFinished(async () => {
    expect(path.dirname(path.resolve(dir))).toBe(path.resolve(tmpdir()));
    expect(path.basename(dir)).toMatch(/^coremind-navigation-fault-/u);
    await rm(dir, { recursive: true, force: true });
  });
  const opts = { dir: path.join(dir, "sessions"), sessionId: "source", cwd: dir };
  const session = await CoreMindSession.open(opts);
  await session.appendMessages([{ role: "user", content: "保留历史", timestamp: 1 }]);
  const make = async () =>
    new ChatSession(
      await CoreMindRuntime.create({
        config: {
          schemaVersion: 2,
          name: "导航失败验收",
          provider: {
            id: "probe",
            model: "probe-model",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKeyEnv: "COREMIND_TEST_API_KEY",
          },
          agents: { main: { tools: [] } },
          session: { enabled: true },
          runtime: { maxRetries: 0 },
        },
        configDir: dir,
        cwd: dir,
        sessionId: "source",
      }),
      "main",
    );
  return { dir, opts, session, make };
}

for (const kind of ["before", "partial", "ack"]) {
  it(`选择分支 ${kind} 失败不报告成功，重新打开按持久事实恢复`, async (context) => {
    const f = await fixture(context);
    const chat = await f.make();
    await chat.createBranch("empty", null);
    fault.kind = kind;
    fault.enabled = true;
    await expect(chat.selectBranch("empty")).rejects.toThrow("注入分支选择写入失败");
    // 首次导航 lane 已写入；旧视图不能猜测选择结果后继续发送。
    await expect(chat.chat("不得发送")).rejects.toMatchObject({ code: "session_snapshot_stale" });
    const reopened = await f.make();
    expect((await reopened.inspectSessionTree()).activeBranch).toBe(
      kind === "ack" ? "empty" : "main",
    );
    await reopened.selectBranch("empty");
    expect((await (await f.make()).inspectSessionTree()).activeBranch).toBe("empty");
  });
}

it("写入和解锁同时失败时保留两个原因，不掩盖原失败", async (context) => {
  const f = await fixture(context);
  const chat = await f.make();
  await chat.createBranch("empty", null);
  fault.kind = "before";
  fault.enabled = true;
  fault.release = true;
  const error = await chat.selectBranch("empty").catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: "session_lock_recovery_required" });
  const cause = (error as Error).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors.map((item: Error) => item.message).join("\n")).toContain(
    "注入分支选择写入失败",
  );
  expect(cause.errors.map((item: Error) => item.message).join("\n")).toContain(
    "注入导航租约释放失败",
  );
  expect((await (await f.make()).inspectSessionTree()).activeBranch).toBe("main");
});

it("分叉公开路径发布失败保留来源与已提交候选，不复制操作记录或静默返回成功", async (context) => {
  const f = await fixture(context);
  const chat = await f.make();
  const tree = await chat.inspectSessionTree();
  const before = await readFile(f.session.filePath, "utf8");
  fault.kind = "alias";
  fault.enabled = true;
  await expect(
    chat.fork({ sessionId: "source", entryId: tree.nodes[0]!.id }),
  ).rejects.toMatchObject({ code: "session_alias_failed" });
  expect(await readFile(f.session.filePath, "utf8")).toBe(before);
  const repo = new JsonlSessionRepo({
    fs: new SessionFileSystem({ cwd: f.dir }),
    sessionsRoot: f.opts.dir,
  });
  const candidates = (await repo.list({ cwd: f.dir })).filter((item) => item.id !== "source");
  expect(candidates).toHaveLength(1);
  const recovered = await CoreMindSession.open({ ...f.opts, sessionId: candidates[0]!.id });
  expect((await recovered.inspectTree()).forkedFrom).toEqual({
    sessionId: "source",
    entryId: tree.nodes[0]!.id,
  });
  expect(await (await repo.open(candidates[0]!)).findRecords()).toEqual([]);
  expect(await readFile(f.session.filePath, "utf8")).toBe(before);
});
