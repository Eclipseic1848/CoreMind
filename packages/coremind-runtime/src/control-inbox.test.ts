import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlInbox } from "./control-inbox.js";
import type { RunId } from "./ids.js";
import { FileRunStore, RunStateJournal } from "./index.js";

describe("ControlInbox", () => {
  it("已应用控制在重启后幂等返回 duplicate，且不会重复应用", async () => {
    const runId = "control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-inbox-"));
    const store = new FileRunStore(directory);
    let applied = 0;
    const command = {
      schemaVersion: 1 as const,
      controlId: "cancel-1",
      runId,
      type: "cancel" as const,
      reason: "用户停止",
    };
    try {
      const journal = new RunStateJournal(runId, store);
      const inbox = new ControlInbox({
        runId,
        journal,
        records: [],
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });

      const first = await inbox.accept(command);
      const records = await store.read(runId);
      const restored = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, records.at(-1)?.sequence ?? 0),
        records,
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });
      const duplicate = await restored.accept(command);

      expect({ first, duplicate, applied }).toEqual({
        first: {
          schemaVersion: 1,
          controlId: "cancel-1",
          runId,
          status: "applied",
          appliedSequence: 2,
        },
        duplicate: {
          schemaVersion: 1,
          controlId: "cancel-1",
          runId,
          status: "duplicate",
          duplicateOf: "applied",
          appliedSequence: 2,
        },
        applied: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("重启后应用 pending 控制且不丢失、不重复", async () => {
    const runId = "pending-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-pending-"));
    const store = new FileRunStore(directory);
    const command = {
      schemaVersion: 1 as const,
      controlId: "approval-1",
      runId,
      type: "approval" as const,
      approvalId: "tool-approval-1",
      decision: "allow" as const,
    };
    let applied = 0;

    try {
      const firstJournal = new RunStateJournal(runId, store);
      const first = new ControlInbox({
        runId,
        journal: firstJournal,
        records: [],
        apply: async () => "accepted",
      });
      const accepted = await first.accept(command);
      const records = await store.read(runId);
      const restored = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, records.at(-1)?.sequence ?? 0),
        records,
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });

      const resumed = await restored.applyPending();
      const duplicate = await restored.accept(command);

      expect({ accepted, resumed, duplicate, applied }).toEqual({
        accepted: {
          schemaVersion: 1,
          controlId: "approval-1",
          runId,
          status: "accepted",
          acceptedSequence: 1,
        },
        resumed: [
          {
            schemaVersion: 1,
            controlId: "approval-1",
            runId,
            status: "applied",
            appliedSequence: 2,
          },
        ],
        duplicate: {
          schemaVersion: 1,
          controlId: "approval-1",
          runId,
          status: "duplicate",
          duplicateOf: "applied",
          appliedSequence: 2,
        },
        applied: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("类型专属字段非法时失败关闭且不写入 Control Fact", async () => {
    const runId = "invalid-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-invalid-"));
    const store = new FileRunStore(directory);
    try {
      const inbox = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => "accepted",
      });
      const invalidCommands: unknown[] = [
        {
          schemaVersion: 1,
          controlId: "approval-invalid",
          runId,
          type: "approval",
          approvalId: "",
          decision: "later",
        },
        { schemaVersion: 1, controlId: "steering-invalid", runId, type: "steering", message: "" },
        { schemaVersion: 1, controlId: "follow-invalid", runId, type: "follow_up", message: 42 },
        { schemaVersion: 1, controlId: "cancel-invalid", runId, type: "cancel", reason: 42 },
      ];

      for (const command of invalidCommands) {
        await expect(inbox.accept(command as never)).rejects.toMatchObject({
          code: "control_invalid",
        });
      }
      expect(await store.read(runId)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
