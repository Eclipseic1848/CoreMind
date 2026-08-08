import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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

  it("未落到稳定步骤边界的副作用会阻止自动恢复", () => {
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
      expect.objectContaining({ code: "unsafe_resume" }),
    );
  });
});

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
