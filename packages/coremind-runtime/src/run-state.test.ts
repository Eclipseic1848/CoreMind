import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopControllerSnapshot } from "./loop-controller.js";
import {
  FileRunStore,
  MemoryRunStore,
  prepareRunResume,
  RunStateJournal,
  type RunStateRecord,
} from "./run-state.js";

describe("RunState", () => {
  it("以只追加 JSONL 顺序保存 start、event 和 finish", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-"));
    const store = new FileRunStore(dir);
    const journal = new RunStateJournal("run-1", store);

    await journal.start({ configName: "demo" });
    journal.event({ type: "agent_start", agent: "main" });
    journal.finish({ status: "succeeded" });
    await journal.flush();

    const records = await store.read("run-1");
    expect(records.map((record) => record.kind)).toEqual(["start", "event", "finish"]);
    expect(records.map((record) => record.sequence)).toEqual([1, 2, 3]);
    expect(await readFile(store.pathFor("run-1"), "utf8")).toContain('"kind":"finish"');
  });

  it("损坏的 RunState 明确报错，不静默丢弃", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-broken-"));
    const store = new FileRunStore(dir);
    writeFileSync(store.pathFor("broken"), "{坏数据", "utf8");

    await expect(store.read("broken")).rejects.toMatchObject({ code: "run_state_corrupt" });
  });

  it("恢复日志从原序号继续追加，不产生重复 sequence", async () => {
    const store = new MemoryRunStore();
    const first = new RunStateJournal("run-resume", store);
    await first.start({ configFingerprint: "same", initialPrompt: "开始" });
    first.event({ type: "trace" });
    await first.flush();

    const resumed = new RunStateJournal("run-resume", store, 2);
    resumed.resume({ completedStepIds: [] });
    resumed.finish({ outcome: { status: "succeeded" } });
    await resumed.flush();

    expect((await store.read("run-resume")).map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("保存 Loop 稳定快照和暂停边界，并在恢复计划中返回最新快照", async () => {
    const store = new MemoryRunStore();
    const journal = new RunStateJournal("run-loop", store);
    const first = loopSnapshot({ phase: "verifying", transitionSequence: 2 });
    const paused = loopSnapshot({
      phase: "paused",
      transitionSequence: 3,
      pauseReason: "manual_review",
      resumePhase: "verifying",
    });

    await journal.start({ configFingerprint: "fingerprint", initialPrompt: "开始" });
    journal.loop(first);
    journal.loop(paused);
    journal.pause({ outcome: { status: "paused" }, loopSnapshot: paused });
    await journal.flush();

    const records = await store.read("run-loop");
    const plan = prepareRunResume(records, "fingerprint");
    expect(records.map((item) => item.kind)).toEqual(["start", "loop", "loop", "pause"]);
    expect(plan.loopSnapshot).toEqual(paused);
    expect(plan.nextJournalSequence).toBe(4);
  });

  it("从稳定步骤输出构造恢复计划", () => {
    const records: RunStateRecord[] = [
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
      record(2, "event", {
        runId: "run-restore",
        sequence: 1,
        timestamp: new Date().toISOString(),
        eventId: "event-1",
        event: {
          type: "step_output",
          stepId: "s1",
          agent: "main",
          text: "已完成",
          saveAs: "first",
        },
      }),
    ];

    const plan = prepareRunResume(records, "fingerprint");

    expect(plan.initialPrompt).toBe("开始");
    expect(plan.nextJournalSequence).toBe(2);
    expect(plan.nextTraceSequence).toBe(1);
    expect(plan.completedSteps.get("s1")).toEqual({
      saveAs: "first",
      output: { text: "已完成", metadata: { agent: "main", stepId: "s1" } },
    });
  });

  it("没有完成收据的副作用会标记为 unknown 并阻止自动恢复", () => {
    const records: RunStateRecord[] = [
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
      record(2, "event", {
        runId: "run-restore",
        sequence: 1,
        timestamp: new Date().toISOString(),
        eventId: "event-1",
        event: {
          type: "tool_call",
          agent: "main",
          stepId: "s1",
          tool: "send_email",
        },
      }),
    ];

    expect(() => prepareRunResume(records, "fingerprint")).toThrowError(
      expect.objectContaining({ code: "unknown_effect" }),
    );
  });

  it("已提交副作用在步骤未稳定完成时不会被自动重放", () => {
    const records: RunStateRecord[] = [
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
      traceRecord(2, 1, {
        type: "tool_call",
        agent: "main",
        stepId: "s1",
        tool: "write",
        idempotencyKey: "run-restore:write-1",
      }),
      traceRecord(3, 2, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:write-1",
        tool: "write",
        status: "committed",
        stepId: "s1",
      }),
    ];

    expect(() => prepareRunResume(records, "fingerprint")).toThrowError(
      expect.objectContaining({ code: "committed_effect_pending" }),
    );
  });

  it("稳定步骤中的已提交副作用随步骤一起跳过，不重复执行", () => {
    const records: RunStateRecord[] = [
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
      traceRecord(2, 1, {
        type: "tool_call",
        agent: "main",
        stepId: "s1",
        tool: "write",
        idempotencyKey: "run-restore:write-1",
      }),
      traceRecord(3, 2, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:write-1",
        tool: "write",
        status: "committed",
        stepId: "s1",
      }),
      traceRecord(4, 3, {
        type: "step_output",
        stepId: "s1",
        agent: "main",
        text: "写入完成",
        saveAs: "written",
      }),
    ];

    const plan = prepareRunResume(records, "fingerprint");

    expect(plan.completedSteps.has("s1")).toBe(true);
    expect(plan.effectReceipts.get("run-restore:write-1")?.status).toBe("committed");
  });
});

function loopSnapshot(overrides: Partial<LoopControllerSnapshot>): LoopControllerSnapshot {
  return {
    schemaVersion: 1,
    machineVersion: "1",
    runId: "run-loop",
    configFingerprint: "fingerprint",
    phase: "idle",
    iteration: 0,
    repairCount: 0,
    repeatedActionCount: 0,
    transitionSequence: 0,
    ...overrides,
  };
}

function traceRecord(
  sequence: number,
  traceSequence: number,
  event: Record<string, unknown>,
): RunStateRecord {
  return record(sequence, "event", {
    runId: "run-restore",
    sequence: traceSequence,
    timestamp: new Date().toISOString(),
    eventId: `event-${traceSequence}`,
    event,
  });
}

function record(sequence: number, kind: RunStateRecord["kind"], payload: unknown): RunStateRecord {
  return {
    version: 1,
    runId: "run-restore",
    sequence,
    timestamp: new Date().toISOString(),
    kind,
    payload,
  };
}
