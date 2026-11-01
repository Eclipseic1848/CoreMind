import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileRunStore } from "./run-state.js";
import { TaskCommitSession } from "./task-commit.js";
import { type TaskDefinition, TaskSession, type TaskSessionOptions } from "./task-session.js";

let workspace: string;
let now: number;
let calls: string[];
const sessions: TaskSession[] = [];
beforeEach(async () => {
  workspace = await mkdtemp(path.join(await realpath(tmpdir()), "coremind-task-sleep-"));
  now = 500;
  calls = [];
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await rm(workspace, { recursive: true, force: true });
});
function definition(): TaskDefinition {
  return {
    type: "sleeper",
    version: 1,
    initialPhase: "a",
    checkpointSchema: { type: "integer" },
    phases: {
      a: () => {
        calls.push("a");
        return { phase: "b", checkpoint: 1, sleepUntil: 1000 };
      },
      b: () => {
        calls.push("b");
        return { phase: "b", checkpoint: 2, done: true };
      },
    },
  };
}
async function open(def = definition(), options: Partial<TaskSessionOptions> = {}) {
  const session = await TaskSession.open({
    workspace,
    sessionId: "sleep",
    definitions: [def],
    clock: () => now,
    ...options,
  });
  sessions.push(session);
  return session;
}
async function sleeping(def = definition(), options: Partial<TaskSessionOptions> = {}) {
  const session = await open(def, options);
  await session.start({ taskId: "job", type: "sleeper", checkpoint: 0 });
  await session.resume("job");
  return session;
}
function log() {
  return readFile(
    path.join(
      workspace,
      ".coremind/tasks",
      createHash("sha256").update("sleep").digest("hex"),
      "commits.jsonl",
    ),
    "utf8",
  );
}

describe("持久期限与唤醒", () => {
  it("A 与睡眠一起提交，早到不推进或消耗 wakeId，到期 wake 不执行 B", async () => {
    const session = await sleeping();
    const state = session.query("job")!;
    expect(state).toMatchObject({
      phase: "b",
      status: "sleeping",
      checkpoint: 1,
      sleep: { wakeAt: 1000 },
    });
    expect(session.nextWake()).toMatchObject({
      taskId: "job",
      sleepId: state.sleep!.sleepId,
      wakeAt: 1000,
      remainingMs: 500,
    });
    const before = await log();
    expect((await session.wake("job", "alarm", state.sleep!.sleepId)).status).toBe("not_due");
    expect(await session.resume("job")).toEqual(state);
    expect(await log()).toBe(before);
    expect(calls).toEqual(["a"]);
    now = 1000;
    expect((await session.wake("job", "alarm", state.sleep!.sleepId)).task).toMatchObject({
      status: "ready",
      checkpoint: 1,
    });
    expect(session.nextWake()).toBeUndefined();
    expect(calls).toEqual(["a"]);
    expect(await session.resume("job")).toMatchObject({ status: "completed", checkpoint: 2 });
    expect(calls).toEqual(["a", "b"]);
  });

  it("重新打开重新计算剩余时间，resume 到期可直接驱动下一阶段", async () => {
    const first = await sleeping();
    const state = first.query("job");
    await first.close();
    now = 750;
    const second = await open();
    expect(second.query("job")).toEqual(state);
    expect(second.nextWake()?.remainingMs).toBe(250);
    now = 1000;
    expect(second.nextWake()?.remainingMs).toBe(0);
    expect(await second.resume("job")).toMatchObject({ status: "completed", checkpoint: 2 });
    expect(calls).toEqual(["a", "b"]);
  });

  it("过去期限立即可唤醒，时钟回拨时重新计算期限", async () => {
    now = 2000;
    const session = await sleeping();
    expect(session.nextWake()?.remainingMs).toBe(0);
    now = 100;
    expect(session.nextWake()?.remainingMs).toBe(900);
    expect((await session.wake("job", "alarm", session.query("job")!.sleep!.sleepId)).status).toBe(
      "not_due",
    );
    now = 2000;
    expect(await session.resume("job")).toMatchObject({ status: "completed" });
  });

  it.each([0, 8_640_000_000_000_000])(
    "允许 Date 有效边界 %s，不创建长期进程内 timer",
    async (deadline) => {
      const def = definition();
      def.phases.a = () => ({ phase: "b", checkpoint: 1, sleepUntil: deadline });
      const session = await sleeping(def);
      expect(session.nextWake()).toMatchObject({
        wakeAt: deadline,
        remainingMs: Math.max(0, deadline - now),
      });
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001, "1000", null])(
    "非法期限 %s 不产生睡眠确认",
    async (deadline) => {
      const def = definition();
      def.phases.a = () => ({ phase: "b", checkpoint: 1, sleepUntil: deadline as number });
      const session = await open(def);
      await session.start({ taskId: "job", type: "sleeper", checkpoint: 0 });
      await expect(session.resume("job")).rejects.toThrow();
      expect(session.query("job")).toMatchObject({ status: "paused", phase: "a", checkpoint: 0 });
      expect(session.nextWake()).toBeUndefined();
    },
  );

  it("完成与睡眠不能同时提交", async () => {
    const def = definition();
    def.phases.a = () => ({ phase: "b", checkpoint: 1, done: true, sleepUntil: 1000 });
    const session = await open(def);
    await session.start({ taskId: "job", type: "sleeper", checkpoint: 0 });
    await expect(session.resume("job")).rejects.toMatchObject({ code: "task_deadline_invalid" });
    expect(session.nextWake()).toBeUndefined();
  });

  it("最近期限按时间和 taskId 稳定排序，取消后不参与 alarm", async () => {
    const def = definition();
    def.phases.a = ({ task }) => ({
      phase: "b",
      checkpoint: task.checkpoint,
      sleepUntil: Number(task.checkpoint),
    });
    const session = await open(def);
    for (const [taskId, checkpoint] of [
      ["z", 900],
      ["a", 900],
      ["late", 1500],
    ] as const) {
      await session.start({ taskId, type: "sleeper", checkpoint });
      await session.resume(taskId);
    }
    expect(session.nextWake()?.taskId).toBe("a");
    await session.cancel("a");
    expect(session.nextWake()?.taskId).toBe("z");
    await session.cancel("z");
    expect(session.nextWake()?.taskId).toBe("late");
    await session.cancel("late");
    expect(session.nextWake()).toBeUndefined();
  });

  it("每次唤醒重新校验时钟，非法时钟不写事实", async () => {
    await expect(open(definition(), { clock: () => Number.NaN })).rejects.toMatchObject({
      code: "task_deadline_invalid",
    });
    const session = await sleeping();
    const state = session.query("job")!;
    const before = await log();
    now = Number.NaN;
    expect(() => session.nextWake()).toThrow();
    await expect(session.wake("job", "alarm", state.sleep!.sleepId)).rejects.toMatchObject({
      code: "task_deadline_invalid",
    });
    expect(await log()).toBe(before);
  });
});

describe("持久唤醒幂等与竞争", () => {
  it("已接受 wakeId 跨重启幂等、冲突 sleepId 拒绝，终态不推进", async () => {
    const first = await sleeping();
    const sleepId = first.query("job")!.sleep!.sleepId;
    now = 1000;
    expect((await first.wake("job", "alarm", sleepId)).status).toBe("accepted");
    await first.close();
    const second = await open();
    const before = await log();
    expect((await second.wake("job", "alarm", sleepId)).status).toBe("duplicate");
    await expect(second.wake("job", "alarm", "different")).rejects.toMatchObject({
      code: "task_wake_conflict",
    });
    expect(await log()).toBe(before);
    await second.resume("job");
    const terminal = await log();
    expect((await second.wake("job", "alarm", sleepId)).status).toBe("duplicate");
    expect((await second.wake("job", "new", sleepId)).status).toBe("terminal");
    expect(await log()).toBe(terminal);
    expect(calls).toEqual(["a", "b"]);
  });

  it("旧 alarm 不能唤醒后续睡眠，即使 deadline 相同", async () => {
    const def = definition();
    def.phases.b = () => ({ phase: "b", checkpoint: 2, sleepUntil: 1000 });
    const session = await sleeping(def);
    const first = session.query("job")!.sleep!.sleepId;
    now = 1000;
    await session.wake("job", "alarm", first);
    await session.resume("job");
    const second = session.query("job")!.sleep!.sleepId;
    expect(second).not.toBe(first);
    expect((await session.wake("job", "alarm", first)).status).toBe("duplicate");
    expect((await session.wake("job", "late-alarm", first)).status).toBe("stale");
    await expect(session.wake("job", "alarm", second)).rejects.toMatchObject({
      code: "task_wake_conflict",
    });
    expect(session.query("job")!.status).toBe("sleeping");
    expect((await session.wake("job", "new-alarm", second)).status).toBe("accepted");
  });

  it("并发 wake 不重复准入，取消后 wake 不恢复", async () => {
    const session = await sleeping();
    const sleepId = session.query("job")!.sleep!.sleepId;
    now = 1000;
    const first = session.wake("job", "alarm", sleepId);
    await expect(session.wake("job", "alarm", sleepId)).rejects.toMatchObject({
      code: "task_busy",
    });
    expect((await first).status).toBe("accepted");
    await session.cancel("job");
    expect((await session.wake("job", "another", sleepId)).status).toBe("terminal");
    expect(await session.resume("job")).toMatchObject({ status: "cancelled" });
    expect(calls).toEqual(["a"]);
  });

  it("取消先于唤醒提交时拒绝准入，最终状态取消", async () => {
    const session = await sleeping();
    const sleepId = session.query("job")!.sleep!.sleepId;
    now = 1000;
    const waking = session.wake("job", "alarm", sleepId);
    const rejected = expect(waking).rejects.toMatchObject({ code: "task_cancelled" });
    const cancelled = session.cancel("job");
    await rejected;
    expect(await cancelled).toMatchObject({ status: "cancelled" });
    expect(session.nextWake()).toBeUndefined();
    expect(calls).toEqual(["a"]);
  });

  it("唤醒原子提交中取消：提交完成后收敛到取消，不执行 B", async () => {
    const session = await sleeping();
    const sleepId = session.query("job")!.sleep!.sleepId;
    now = 1000;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commit = FileRunStore.prototype.commit;
    vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(
      async function (record, durability) {
        if (JSON.stringify(record.payload).includes('"wakes":{"alarm"')) {
          entered();
          await blocked;
        }
        return commit.call(this, record, durability);
      },
    );
    const waking = session.wake("job", "alarm", sleepId);
    await started;
    const cancelled = session.cancel("job");
    release();
    expect((await waking).status).toBe("accepted");
    expect(await cancelled).toMatchObject({ status: "cancelled" });
    expect(calls).toEqual(["a"]);
  });

  it("配置或定义变化不能通过 wake 扩权", async () => {
    const first = await sleeping();
    const sleepId = first.query("job")!.sleep!.sleepId;
    await first.close();
    now = 1000;
    const changed = await open({ ...definition(), version: 2 });
    await expect(changed.wake("job", "alarm", sleepId)).rejects.toMatchObject({
      code: "task_definition_mismatch",
    });
    await changed.close();
    const elevated = await open(definition(), {
      runtime: {
        authorityVersion: "new",
        configDir: workspace,
        config: { schemaVersion: 2, name: "权限变化", agents: { main: {} } },
      },
    });
    await expect(elevated.wake("job", "alarm", sleepId)).rejects.toMatchObject({
      code: "task_authority_mismatch",
    });
    expect(calls).toEqual(["a"]);
  });

  it("到期前不迁移或执行；显式迁移保留期限，到期后一次推进", async () => {
    const first = await sleeping();
    await first.close();
    const migrate = vi.fn((previous) => ({ phase: previous.phase, checkpoint: 10 }));
    const changed = await open({ ...definition(), version: 2, migrate });
    expect((await changed.resume("job")).status).toBe("sleeping");
    expect(migrate).not.toHaveBeenCalled();
    now = 1000;
    expect((await changed.resume("job")).status).toBe("completed");
    expect(migrate).toHaveBeenCalledOnce();
    expect(calls).toEqual(["a", "b"]);
  });

  it.each(["", "../alarm", "x".repeat(129)])("拒绝非法 wakeId %s", async (wakeId) => {
    const session = await sleeping();
    await expect(
      session.wake("job", wakeId, session.query("job")!.sleep!.sleepId),
    ).rejects.toMatchObject({ code: "task_wake_conflict" });
  });
});

describe("提交屏障与恢复", () => {
  it.each([false, true])("睡眠提交失败不确认，重开核对真实事实；已写入=%s", async (afterCommit) => {
    const session = await open();
    await session.start({ taskId: "job", type: "sleeper", checkpoint: 0 });
    const commit = FileRunStore.prototype.commit;
    vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(
      async function (record, durability) {
        if (afterCommit) await commit.call(this, record, durability);
        throw new Error("夹具：睡眠提交 I/O 未确认");
      },
    );
    await expect(session.resume("job")).rejects.toThrow();
    expect(() => session.query("job")).toThrow();
    await session.close();
    vi.restoreAllMocks();
    const restored = await open();
    expect(restored.query("job")).toMatchObject({
      status: afterCommit ? "sleeping" : "ready",
      phase: afterCommit ? "b" : "a",
      checkpoint: afterCommit ? 1 : 0,
    });
  });

  it("唤醒已写入但回执失败，重开同 wakeId 不重复写入", async () => {
    const session = await sleeping();
    const sleepId = session.query("job")!.sleep!.sleepId;
    now = 1000;
    const commit = FileRunStore.prototype.commit;
    vi.spyOn(FileRunStore.prototype, "commit").mockImplementation(
      async function (record, durability) {
        await commit.call(this, record, durability);
        throw new Error("夹具：唤醒回执丢失");
      },
    );
    await expect(session.wake("job", "alarm", sleepId)).rejects.toThrow("回执丢失");
    await session.close();
    vi.restoreAllMocks();
    const restored = await open();
    const before = await log();
    expect((await restored.wake("job", "alarm", sleepId)).status).toBe("duplicate");
    expect(await log()).toBe(before);
    expect((await restored.resume("job")).status).toBe("completed");
    expect(calls).toEqual(["a", "b"]);
  });

  it("睡眠身份缺失的持久记录拒绝恢复", async () => {
    const session = await sleeping();
    await session.close();
    const store = await TaskCommitSession.open({
      workspace,
      sessionId: "sleep",
      documentSchemas: [],
    });
    const projection = store.snapshot();
    const task = projection.tasks.job!;
    delete (task.checkpoint as Record<string, unknown>).sleep;
    await store.commit({
      schemaVersion: 1,
      commitId: "corruption",
      expectedRevision: projection.revision,
      taskId: "job",
      task,
      documents: [],
      entries: [],
    });
    await store.close();
    const restored = await open();
    expect(() => restored.query("job")).toThrow("睡眠身份");
    await expect(restored.resume("job")).rejects.toMatchObject({ code: "task_checkpoint_invalid" });
  });
});
