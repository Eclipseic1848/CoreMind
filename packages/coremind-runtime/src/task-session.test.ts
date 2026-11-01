import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCommitSession } from "./task-commit.js";
import {
  type TaskDefinition,
  type TaskPhaseContext,
  TaskSession,
  type TaskSessionOptions,
} from "./task-session.js";

let workspace: string;
const sessions: TaskSession[] = [];
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-phase-"));
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await rm(workspace, { recursive: true, force: true });
});

function definition(): TaskDefinition {
  return {
    type: "example",
    version: 1,
    initialPhase: "a",
    checkpointSchema: { type: "integer" },
    phases: {
      a: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1 }),
      b: ({ task }) => ({ phase: "b", checkpoint: Number(task.checkpoint) + 1, done: true }),
    },
  };
}
async function open(def = definition(), extra: Partial<TaskSessionOptions> = {}) {
  const session = await TaskSession.open({
    workspace,
    sessionId: "phases",
    definitions: [def],
    ...extra,
  });
  sessions.push(session);
  return session;
}
function log() {
  return readFile(
    path.join(
      workspace,
      ".coremind/tasks",
      createHash("sha256").update("phases").digest("hex"),
      "commits.jsonl",
    ),
    "utf8",
  );
}

describe("公共任务阶段合同", () => {
  it("start 不执行处理器；resume 每次原子推进一个阶段，终态不重做", async () => {
    const session = await open();
    expect(session.query("job")).toBeUndefined();
    expect(await session.start({ taskId: "job", type: "example", checkpoint: 0 })).toMatchObject({
      phase: "a",
      status: "ready",
      checkpoint: 0,
    });
    expect(await session.resume("job")).toMatchObject({
      phase: "b",
      status: "ready",
      checkpoint: 1,
    });
    expect(await session.resume("job")).toMatchObject({
      phase: "b",
      status: "completed",
      checkpoint: 2,
    });
    const before = await log();
    expect(await session.resume("job")).toMatchObject({ status: "completed", checkpoint: 2 });
    expect(await session.cancel("job")).toMatchObject({ status: "completed" });
    expect(await log()).toBe(before);
  });

  it("重新打开从已提交阶段顶部继续，不重做 A", async () => {
    const first = await open();
    await first.start({ taskId: "job", type: "example", checkpoint: 0 });
    await first.resume("job");
    await first.close();
    const second = await open();
    expect(await second.resume("job")).toMatchObject({ status: "completed", checkpoint: 2 });
  });

  it("独立快照与注册副本不能被调用方改写", async () => {
    const def = definition();
    const session = await open(def);
    def.phases.a = () => ({ phase: "b", checkpoint: 99 });
    const state = await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    state.checkpoint = 99;
    expect(await session.resume("job")).toMatchObject({ checkpoint: 1 });
  });

  it("拒绝未知类型、缺失任务和重复 taskId", async () => {
    const session = await open();
    await expect(
      session.start({ taskId: "job", type: "other", checkpoint: 0 }),
    ).rejects.toMatchObject({ code: "task_definition_unknown" });
    await expect(session.resume("missing")).rejects.toMatchObject({ code: "task_not_found" });
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await expect(
      session.start({ taskId: "job", type: "example", checkpoint: 0 }),
    ).rejects.toMatchObject({ code: "task_already_exists" });
  });

  it.each([null, "x", Number.NaN, undefined])("拒绝非法初始检查点 %s", async (checkpoint) => {
    const session = await open();
    await expect(
      session.start({ taskId: "job", type: "example", checkpoint: checkpoint as never }),
    ).rejects.toMatchObject({ code: "task_checkpoint_invalid" });
    expect(session.query("job")).toBeUndefined();
  });

  it("检查点拒绝访问器且不执行 getter", async () => {
    const getter = vi.fn(() => {
      throw new Error("不应执行访问器");
    });
    const checkpoint = Object.defineProperty({}, "value", { get: getter, enumerable: true });
    const session = await open();
    await expect(
      session.start({ taskId: "job", type: "example", checkpoint }),
    ).rejects.toMatchObject({ code: "task_checkpoint_invalid" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("处理器抛错不推进检查点，下一次从顶部重进", async () => {
    let calls = 0;
    const def = definition();
    def.phases.a = () => {
      if (++calls === 1) throw new Error("预期失败");
      return { phase: "b", checkpoint: 1 };
    };
    const session = await open(def);
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await expect(session.resume("job")).rejects.toThrow("预期失败");
    expect(session.query("job")).toMatchObject({ phase: "a", status: "paused", checkpoint: 0 });
    expect(await session.resume("job")).toMatchObject({ phase: "b", checkpoint: 1 });
    expect(calls).toBe(2);
  });

  it.each([
    { phase: "unknown", checkpoint: 1 },
    { phase: "b", checkpoint: "bad" },
    { phase: "b", checkpoint: 1, done: "yes" },
    { phase: "b", checkpoint: 1, permissions: {} },
  ])("非法阶段结果不推进任务", async (result) => {
    const def = definition();
    def.phases.a = () => result as never;
    const session = await open(def);
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await expect(session.resume("job")).rejects.toMatchObject({ code: "task_checkpoint_invalid" });
    expect(session.query("job")).toMatchObject({ phase: "a", checkpoint: 0, status: "paused" });
  });

  it("阶段、document、entry 属于同一个持久提交", async () => {
    const def = definition();
    def.phases.a = () => ({
      phase: "b",
      checkpoint: 1,
      documents: [{ id: "doc", type: "counter", version: 1, value: 1 }],
      entries: [{ id: "entry", role: "assistant", text: "阶段 A 完成" }],
    });
    const documentSchemas = [{ type: "counter", version: 1, schema: { type: "integer" } }];
    const session = await open(def, { documentSchemas });
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await session.resume("job");
    await session.close();
    const store = await TaskCommitSession.open({ workspace, sessionId: "phases", documentSchemas });
    try {
      expect(store.snapshot()).toMatchObject({
        revision: 2,
        tasks: { job: { phase: "b", checkpoint: { checkpoint: 1 } } },
        documents: { doc: { value: 1 } },
        entries: [{ text: "阶段 A 完成" }],
      });
    } finally {
      await store.close();
    }
  });

  it("同会话并发被拒绝，取消不伪造阶段完成", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const def = definition();
    def.phases.a = async () => {
      entered();
      return new Promise(() => {});
    };
    const session = await open(def);
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    const running = session.resume("job");
    const rejected = expect(running).rejects.toMatchObject({ code: "task_cancelled" });
    await ready;
    await expect(session.resume("job")).rejects.toMatchObject({ code: "task_busy" });
    expect(await session.cancel("job")).toMatchObject({
      phase: "a",
      checkpoint: 0,
      status: "cancelled",
    });
    await rejected;
    const before = await log();
    expect(await session.resume("job")).toMatchObject({ status: "cancelled" });
    expect(await log()).toBe(before);
  });

  it("关闭阻断迟到的 Run 调用并释放 writer", async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let context!: TaskPhaseContext;
    const def = definition();
    def.phases.a = async (ctx) => {
      context = ctx;
      entered();
      return new Promise(() => {});
    };
    const session = await open(def);
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    const running = session.resume("job");
    const rejected = expect(running).rejects.toMatchObject({ code: "task_cancelled" });
    await ready;
    await session.close();
    await rejected;
    await expect(context.run("迟到调用")).rejects.toMatchObject({ code: "task_cancelled" });
    expect(() => session.query("job")).toThrow("任务会话已关闭");
    const next = await open(def);
    expect(next.query("job")).toMatchObject({ status: "cancelled", checkpoint: 0 });
  });

  it("沿用步骤超时，超时后不提交迟到结果", async () => {
    let finish!: (value: { phase: string; checkpoint: number }) => void;
    const def = definition();
    def.phases.a = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const session = await open(def, {
      runtime: {
        authorityVersion: "timed",
        configDir: workspace,
        config: { schemaVersion: 2, name: "计时", agents: { main: {} } },
        stepTimeoutMs: 20,
      },
    });
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await expect(session.resume("job")).rejects.toMatchObject({ code: "task_phase_timeout" });
    const before = await log();
    finish({ phase: "b", checkpoint: 99 });
    await Promise.resolve();
    expect(session.query("job")).toMatchObject({ phase: "a", status: "paused", checkpoint: 0 });
    expect(await log()).toBe(before);
  });

  it("并发 start 拒绝，不覆盖首次输入", async () => {
    const session = await open();
    const first = session.start({ taskId: "job", type: "example", checkpoint: 1 });
    await expect(
      session.start({ taskId: "job", type: "example", checkpoint: 2 }),
    ).rejects.toMatchObject({ code: "task_busy" });
    expect(await first).toMatchObject({ checkpoint: 1 });
  });

  it("存活 writer 阻止另一会话持有相同任务存储", async () => {
    await open();
    await expect(open()).rejects.toMatchObject({ code: "session_write_locked" });
  });

  it.each([
    null,
    { ...definition(), type: undefined },
    { ...definition(), version: 0 },
    { ...definition(), checkpointSchema: { $async: true, type: "integer" } },
    { ...definition(), checkpointSchema: { $ref: "https://example.invalid/schema" } },
  ])("非法任务定义在写入前拒绝", async (def) => {
    await expect(open(def as never)).rejects.toMatchObject({ code: "task_definition_invalid" });
  });

  it("公共任务入口不能注入替代 RunStore 绕开持久 Facts", async () => {
    await expect(
      open(definition(), {
        runtime: {
          authorityVersion: "policy-1",
          configDir: workspace,
          config: { schemaVersion: 2, name: "禁止替换", agents: { main: {} } },
          runStore: {},
        } as never,
      }),
    ).rejects.toMatchObject({ code: "task_definition_invalid" });
  });
});

describe("显式版本迁移", () => {
  async function original() {
    const session = await open();
    await session.start({ taskId: "job", type: "example", checkpoint: 0 });
    await session.close();
  }
  it("缺少注册、同版本定义变化和无迁移版本变化均不写事实", async () => {
    await original();
    const before = await log();
    for (const definitions of [
      [],
      [{ ...definition(), version: 2 }],
      [{ ...definition(), checkpointSchema: { type: "number" } }],
    ]) {
      const session = await open(definition(), { definitions });
      await expect(session.resume("job")).rejects.toMatchObject({
        code: definitions.length ? "task_definition_mismatch" : "task_definition_unknown",
      });
      await session.close();
      expect(await log()).toBe(before);
    }
  });

  it.each(["throw", "schema", "fields", "phase"])(
    "迁移 %s 失败保持旧事实逐字节不变",
    async (mode) => {
      await original();
      const before = await log();
      const def = {
        ...definition(),
        version: 2,
        migrate: () => {
          if (mode === "throw") throw new Error("预期迁移异常");
          if (mode === "schema") return { phase: "a", checkpoint: "bad" };
          if (mode === "fields") return { phase: "a", checkpoint: 1, authority: "new" };
          return { phase: "unknown", checkpoint: 1 };
        },
      };
      const session = await open(def);
      await expect(session.resume("job")).rejects.toMatchObject({ code: "task_migration_failed" });
      expect(await log()).toBe(before);
    },
  );

  it("成功迁移只提交一次版本和状态，重开不再次迁移", async () => {
    await original();
    let calls = 0;
    const def = {
      ...definition(),
      version: 2,
      migrate: () => {
        calls++;
        return { phase: "a", checkpoint: 10 };
      },
    };
    const session = await open(def);
    expect(await session.resume("job")).toMatchObject({ version: 2, phase: "b", checkpoint: 11 });
    await session.close();
    const next = await open(def);
    expect(await next.resume("job")).toMatchObject({
      version: 2,
      status: "completed",
      checkpoint: 12,
    });
    expect(calls).toBe(1);
    const records = (await log())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records[1].payload.commit.task).toMatchObject({
      version: 2,
      phase: "a",
      checkpoint: { checkpoint: 10 },
    });
  });

  it("权限配置变化先于迁移被拒绝", async () => {
    await original();
    const before = await log();
    const migrate = vi.fn(() => ({ phase: "a", checkpoint: 1 }));
    const session = await open(
      { ...definition(), version: 2, migrate },
      {
        runtime: {
          authorityVersion: "policy-1",
          configDir: workspace,
          config: { schemaVersion: 2, name: "权限改变", agents: { main: {} } },
        },
      },
    );
    await expect(session.resume("job")).rejects.toMatchObject({ code: "task_authority_mismatch" });
    expect(migrate).not.toHaveBeenCalled();
    expect(await log()).toBe(before);
  });
});
