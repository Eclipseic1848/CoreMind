import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors.js";
import { FileRunStore, MemoryRunStore } from "./run-state.js";
import {
  type TaskCommit,
  TaskCommitSession,
  type TaskCommitSessionOptions,
  type TaskDocumentSchema,
} from "./task-commit.js";

const documentSchemas: TaskDocumentSchema[] = [
  {
    type: "progress",
    version: 1,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["done"],
      properties: { done: { type: "integer", minimum: 0 } },
    },
  },
];
let workspace: string;
let temporaryRoot: string;
let sessions: TaskCommitSession[];
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  workspace = await mkdtemp(path.join(temporaryRoot, "coremind-task-commit-"));
  sessions = [];
});
afterEach(async () => {
  for (const session of sessions) await session.close();
  expect(path.dirname(workspace)).toBe(temporaryRoot);
  expect(path.basename(workspace)).toMatch(/^coremind-task-commit-/u);
  await rm(workspace, { recursive: true, force: true });
});

function transaction(overrides: Partial<TaskCommit> = {}): TaskCommit {
  return {
    schemaVersion: 1,
    commitId: "commit-1",
    expectedRevision: 0,
    taskId: "job",
    task: { type: "example", version: 1, phase: "after-a", checkpoint: { a: "完成" } },
    documents: [{ id: "progress", type: "progress", version: 1, value: { done: 1 } }],
    entries: [{ id: "entry-1", role: "assistant", text: "A 已完成" }],
    ...overrides,
  };
}

async function open(options: Partial<TaskCommitSessionOptions> = {}): Promise<TaskCommitSession> {
  const session = await TaskCommitSession.open({
    workspace,
    sessionId: "example",
    documentSchemas,
    ...options,
  });
  sessions.push(session);
  return session;
}

function journal(): string {
  return path.join(
    workspace,
    ".coremind",
    "tasks",
    createHash("sha256").update("example", "utf8").digest("hex"),
    "commits.jsonl",
  );
}

describe("显式任务会话的原子提交", () => {
  it("同一持久提交生成三类完整视图，重开只从事实重建", async () => {
    const session = await open();
    const commit = transaction();
    expect(await session.commit(commit)).toEqual({
      commitId: "commit-1",
      revision: 1,
      durabilityBoundary: "process_crash",
    });
    const snapshot = session.snapshot();
    expect(snapshot).toEqual({
      revision: 1,
      tasks: { job: commit.task },
      documents: { progress: commit.documents[0] },
      entries: commit.entries,
    });
    const rows = (await readFile(journal(), "utf8")).trim().split("\n");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!).kind).toBe("task_commit");
    await session.close();
    const restored = await open();
    expect(restored.snapshot()).toEqual(snapshot);
    expect(await restored.commit(commit)).toMatchObject({ revision: 1 });
    expect((await readFile(journal(), "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("复制输入与返回投影，调用者不能改变已排队事务或持久状态", async () => {
    const session = await open();
    const commit = transaction();
    const writing = session.commit(commit);
    commit.task.phase = "被调用者修改";
    commit.entries[0]!.text = "被调用者修改";
    await writing;
    const snapshot = session.snapshot();
    snapshot.tasks.job!.phase = "修改返回值";
    snapshot.documents.progress!.value = null;
    snapshot.entries.length = 0;
    expect(session.snapshot().tasks.job!.phase).toBe("after-a");
    expect(session.snapshot().entries).toHaveLength(1);
    expect(session.snapshot().documents.progress!.value).toEqual({ done: 1 });
  });

  it("持久屏障未完成时只可见旧投影，完成后整体可见", async () => {
    let release!: () => void;
    let reached!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const session = await open({
      store: (directory) =>
        new FileRunStore(directory, {
          repairTornTail: false,
          beforeBarrier: async () => {
            reached();
            await barrier;
          },
        }),
    });
    const writing = session.commit(transaction());
    try {
      await waiting;
      expect(session.snapshot()).toEqual({ revision: 0, tasks: {}, documents: {}, entries: [] });
    } finally {
      release();
      await writing;
    }
    const saved = session.snapshot();
    expect(saved.revision).toBe(1);
    expect(saved.tasks.job).toEqual(transaction().task);
    expect(saved.documents.progress).toEqual(transaction().documents[0]);
    expect(saved.entries).toEqual(transaction().entries);
  });

  it("同 commitId 异内容拒绝；并发相同 revision 只有一个成功", async () => {
    const session = await open();
    const outcomes = await Promise.allSettled([
      session.commit(transaction()),
      session.commit(transaction({ commitId: "racing-commit" })),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "task_commit_conflict" },
    });
    await expect(session.commit(transaction({ taskId: "other" }))).rejects.toMatchObject({
      code: "task_commit_conflict",
    });
    await expect(
      session.commit(transaction({ commitId: "duplicate-entry", expectedRevision: 1 })),
    ).rejects.toMatchObject({ code: "task_commit_conflict" });
    await session.commit(transaction({ commitId: "commit-2", expectedRevision: 1, entries: [] }));
    expect(session.snapshot().revision).toBe(2);
  });

  it("同存储第二写入者被拒绝；close 等待已接收写入但拒绝新准入", async () => {
    const session = await open();
    await expect(open()).rejects.toMatchObject({ code: "session_write_locked" });
    const pending = session.commit(transaction());
    const closing = session.close();
    await expect(session.commit(transaction())).rejects.toMatchObject({
      code: "task_store_unavailable",
    });
    await pending;
    await closing;
    expect(() => session.snapshot()).toThrowError(
      expect.objectContaining({ code: "task_store_unavailable" }),
    );
    expect((await open()).snapshot().revision).toBe(1);
  });

  it.each([
    { schemaVersion: 2 },
    { commitId: "../escape" },
    { taskId: "" },
    { expectedRevision: -1 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { task: { type: "example", version: 0, phase: "a", checkpoint: null } },
    { documents: [{ id: "progress", type: "missing", version: 1, value: {} }] },
    { documents: [{ id: "progress", type: "progress", version: 2, value: { done: 1 } }] },
    { documents: [{ id: "progress", type: "progress", version: 1, value: { done: -1 } }] },
    { entries: [{ id: "e", role: "toolResult", text: "未支持的消息" }] },
    { documents: [...transaction().documents, ...transaction().documents] },
    { entries: [...transaction().entries, ...transaction().entries] },
    { extra: true },
  ])("无效字段/Schema 整体拒绝：%j", async (override) => {
    const session = await open();
    await expect(
      session.commit({ ...transaction(), ...override } as TaskCommit),
    ).rejects.toMatchObject({ code: "task_commit_invalid" });
    expect(session.snapshot()).toEqual({ revision: 0, tasks: {}, documents: {}, entries: [] });
    await expect(readFile(journal(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), 1n, () => 1])(
    "拒绝非 JSON checkpoint：%s",
    async (checkpoint) => {
      const session = await open();
      const commit = transaction();
      commit.task.checkpoint = checkpoint as never;
      await expect(session.commit(commit)).rejects.toMatchObject({ code: "task_commit_invalid" });
      expect(session.snapshot().revision).toBe(0);
    },
  );

  it("拒绝循环、访问器和超大提交；不调用访问器", async () => {
    const session = await open();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let reads = 0;
    const getter = {
      get secret() {
        reads++;
        return "不会读取";
      },
    };
    for (const checkpoint of [cyclic, getter, "x".repeat(1024 * 1024)]) {
      const commit = transaction();
      commit.task.checkpoint = checkpoint as never;
      await expect(session.commit(commit)).rejects.toMatchObject({ code: "task_commit_invalid" });
    }
    expect(reads).toBe(0);
    expect(session.snapshot().revision).toBe(0);
  });

  it.each(["beforeCommit", "beforeBarrier"] as const)(
    "%s 失败不发布部分状态；旧 holder 失效，重开保持旧事务",
    async (hook) => {
      const session = await open({
        store: (directory) =>
          new FileRunStore(directory, {
            [hook]: async ({ record }: { record?: { sequence: number } }) => {
              if (record?.sequence === 2) throw new Error("注入持久写入失败");
            },
          }),
      });
      await session.commit(transaction());
      const before = session.snapshot();
      await expect(
        session.commit(transaction({ commitId: "commit-2", expectedRevision: 1, entries: [] })),
      ).rejects.toMatchObject({ code: "durability_barrier_failed" });
      expect(() => session.snapshot()).toThrowError(
        expect.objectContaining({ code: "task_store_unavailable" }),
      );
      await session.close();
      expect((await open()).snapshot()).toEqual(before);
    },
  );

  it("落盘后回执不符不伪造成功；重开能核对完整的已提交事务", async () => {
    const session = await open({
      store: (directory) => {
        const store = new FileRunStore(directory);
        const commit = store.commit.bind(store);
        store.commit = async (record, durability) => {
          const receipt = await commit(record, durability);
          return { ...receipt, achieved: "ordinary" };
        };
        return store;
      },
    });
    await expect(session.commit(transaction())).rejects.toMatchObject({
      code: "durability_barrier_failed",
    });
    await expect(session.commit(transaction())).rejects.toMatchObject({
      code: "task_store_unavailable",
    });
    await session.close();
    const restored = (await open()).snapshot();
    expect(restored.revision).toBe(1);
    expect(restored.tasks.job!.phase).toBe("after-a");
    expect(restored.documents.progress!.value).toEqual({ done: 1 });
    expect(restored.entries[0]!.id).toBe("entry-1");
  });

  it("不具备原子性/持久性声明的自定义 Store 失败关闭且释放租约", async () => {
    await expect(open({ store: () => new MemoryRunStore() })).rejects.toMatchObject({
      code: "durability_unsupported",
    });
    await expect(
      open({
        store: (directory) => {
          const store = new FileRunStore(directory);
          Object.defineProperty(store, "atomicCriticalCommit", { value: undefined });
          return store;
        },
      }),
    ).rejects.toMatchObject({ code: "durability_unsupported" });
    await expect(
      open({ store: (directory) => new FileRunStore(path.dirname(directory)) }),
    ).rejects.toMatchObject({ code: "policy_denied" });
    await (await open()).commit(transaction());
  });

  it("任务 Schema 更新或复制事实到另一工作区不得静默恢复", async () => {
    const session = await open();
    await session.commit(transaction());
    await session.close();
    await expect(
      open({ documentSchemas: [{ ...documentSchemas[0]!, schema: { type: "object" } }] }),
    ).rejects.toMatchObject({ code: "task_store_corrupt" });
    const other = path.join(workspace, "other");
    await mkdir(other);
    const empty = await open({ workspace: other });
    await empty.close();
    const relative = path.relative(workspace, journal());
    await copyFile(journal(), path.join(other, relative));
    await expect(open({ workspace: other })).rejects.toMatchObject({ code: "task_store_corrupt" });
    expect((await open()).snapshot().revision).toBe(1);
  });

  it.each(["schemaVersion", "duplicate", "workspace"] as const)(
    "持久事实篡改 %s 被拒绝",
    async (kind) => {
      const session = await open();
      await session.commit(transaction());
      await session.close();
      const row = JSON.parse(await readFile(journal(), "utf8"));
      if (kind === "schemaVersion") row.payload.commit.schemaVersion = 2;
      if (kind === "workspace") row.payload.workspaceKey = "其他工作区";
      let text = `${JSON.stringify(row)}\n`;
      if (kind === "duplicate") {
        row.sequence = 2;
        row.payload.commit.expectedRevision = 1;
        text += `${JSON.stringify(row)}\n`;
      }
      await writeFile(journal(), text, "utf8");
      await expect(open()).rejects.toMatchObject({ code: "task_store_corrupt" });
    },
  );

  it("原子任务日志截断时保留损坏现场，不套用普通 Run 的尾部修复", async () => {
    const session = await open();
    await session.commit(transaction());
    await session.close();
    await appendFile(journal(), '{"version":1,"runId":"commits"', "utf8");
    const damaged = await readFile(journal(), "utf8");
    await expect(open()).rejects.toMatchObject({ code: "run_state_corrupt" });
    expect(await readFile(journal(), "utf8")).toBe(damaged);
  });

  it("拒绝符号目录、硬链接日志和路径穿越身份", async () => {
    const outside = path.join(workspace, "outside");
    await mkdir(outside);
    await symlink(
      outside,
      path.join(workspace, ".coremind"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(open()).rejects.toMatchObject({ code: "policy_denied" });
    await rm(path.join(workspace, ".coremind"));
    await expect(open({ sessionId: "../escape" })).rejects.toMatchObject({
      code: "invalid_session_id",
    });
    const session = await open();
    await session.commit(transaction());
    await session.close();
    await link(journal(), path.join(outside, "linked.jsonl"));
    await expect(open()).rejects.toMatchObject({ code: "policy_denied" });
  });

  it.each([
    [{ type: "x", version: 1, schema: { type: "unknown" } }],
    [{ type: "x", version: 1, schema: { $async: true, type: "object" } }],
    [{ type: "x", version: 1, schema: { $ref: "https://invalid.example/schema.json" } }],
    [documentSchemas[0], documentSchemas[0]],
    [null],
    [],
  ])("Schema 注册仅接受明确同步合同：%j", async (...items) => {
    // 空表本身合法，但不能接受未注册的 document。
    const definitions = items as TaskDocumentSchema[];
    if (definitions.length === 0) {
      const session = await open({ documentSchemas: [] });
      await expect(session.commit(transaction())).rejects.toMatchObject({
        code: "task_commit_invalid",
      });
    } else {
      await expect(open({ documentSchemas: definitions })).rejects.toMatchObject({
        code: "task_commit_invalid",
      });
    }
  });

  it("四类新错误都登记为确定性失败，不进入自动重试", () => {
    for (const code of [
      "task_commit_invalid",
      "task_commit_conflict",
      "task_store_corrupt",
      "task_store_unavailable",
    ] as const) {
      expect(ERROR_CODES[code]).toMatchObject({ retryClass: "fatal", runStatus: "failed" });
    }
  });
});
