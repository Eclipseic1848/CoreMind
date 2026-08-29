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

  it("并发重复 controlId 只持久化并应用一次", async () => {
    const runId = "concurrent-duplicate-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-concurrent-duplicate-"));
    const store = new FileRunStore(directory);
    const command = {
      schemaVersion: 1 as const,
      controlId: "cancel-concurrent-duplicate",
      runId,
      type: "cancel" as const,
      reason: "用户停止",
    };
    let applied = 0;

    try {
      const inbox = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });

      const [first, duplicate] = await Promise.all([inbox.accept(command), inbox.accept(command)]);
      const records = await store.read(runId);

      expect({ first, duplicate, applied, factCount: records.length }).toEqual({
        first: {
          schemaVersion: 1,
          controlId: command.controlId,
          runId,
          status: "applied",
          appliedSequence: 2,
        },
        duplicate: {
          schemaVersion: 1,
          controlId: command.controlId,
          runId,
          status: "duplicate",
          duplicateOf: "applied",
          appliedSequence: 2,
        },
        applied: 1,
        factCount: 2,
      });
      expect(
        () =>
          new ControlInbox({
            runId,
            journal: new RunStateJournal(runId, store, records.at(-1)?.sequence ?? 0),
            records,
            apply: async () => "applied",
          }),
      ).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("父终态封口等待正在落盘的处置，并拒绝封口后的新处置", async () => {
    const runId = "control-terminal-seal-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-terminal-seal-"));
    const store = new FileRunStore(directory);
    let enterApply!: () => void;
    let releaseApply!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      enterApply = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    try {
      const inbox = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => {
          enterApply();
          await applyReleased;
          return "applied";
        },
      });
      const firstCommand = {
        schemaVersion: 1 as const,
        controlId: "redelegate-before-terminal",
        runId,
        type: "delegation_disposition" as const,
        delegationId: "delegation-before-terminal",
        action: "redelegate" as const,
        reason: "人工选择安全重新委派",
      };

      const accepted = inbox.accept(firstCommand);
      await applyEntered;
      let sealed = false;
      const seal = inbox.sealForTerminal().then(() => {
        sealed = true;
      });
      await Promise.resolve();
      expect(sealed).toBe(false);

      releaseApply();
      await expect(accepted).resolves.toMatchObject({ status: "applied" });
      await seal;

      await expect(
        inbox.accept({
          ...firstCommand,
          controlId: "redelegate-after-terminal",
          delegationId: "delegation-after-terminal",
        }),
      ).rejects.toMatchObject({ code: "control_unavailable" });
      expect(
        (await store.read(runId)).filter(
          (record) =>
            record.kind === "control" && record.payload.controlId === "redelegate-after-terminal",
        ),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("父终态封口等待恢复期 pending 控制完成应用", async () => {
    const runId = "control-pending-terminal-seal-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-pending-terminal-seal-"));
    const store = new FileRunStore(directory);
    const command = {
      schemaVersion: 1 as const,
      controlId: "pending-redelegate-before-terminal",
      runId,
      type: "delegation_disposition" as const,
      delegationId: "pending-delegation-before-terminal",
      action: "redelegate" as const,
      reason: "恢复期应用安全重新委派",
    };
    let enterApply!: () => void;
    let releaseApply!: () => void;
    const applyEntered = new Promise<void>((resolve) => {
      enterApply = resolve;
    });
    const applyReleased = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });

    try {
      const first = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => "accepted",
      });
      await first.accept(command);
      const records = await store.read(runId);
      const restored = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, records.at(-1)?.sequence ?? 0),
        records,
        apply: async () => {
          enterApply();
          await applyReleased;
          return "applied";
        },
      });

      const pending = restored.applyPending("delegation_disposition");
      await applyEntered;
      let sealed = false;
      const seal = restored.sealForTerminal().then(() => {
        sealed = true;
      });
      await Promise.resolve();
      expect(sealed).toBe(false);

      releaseApply();
      await expect(pending).resolves.toEqual([
        expect.objectContaining({ controlId: command.controlId, status: "applied" }),
      ]);
      await seal;
      expect((await store.read(runId)).at(-1)).toMatchObject({
        kind: "control",
        payload: { controlId: command.controlId, state: "applied" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("并发冲突 controlId 只绑定首个命令", async () => {
    const runId = "concurrent-conflict-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-concurrent-conflict-"));
    const store = new FileRunStore(directory);
    const firstCommand = {
      schemaVersion: 1 as const,
      controlId: "cancel-concurrent-conflict",
      runId,
      type: "cancel" as const,
      reason: "第一次请求",
    };
    const conflictingCommand = { ...firstCommand, reason: "冲突请求" };
    let applied = 0;

    try {
      const inbox = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });

      const [first, conflict] = await Promise.all([
        inbox.accept(firstCommand),
        inbox.accept(conflictingCommand),
      ]);
      const records = await store.read(runId);

      expect(first).toMatchObject({ status: "applied", appliedSequence: 2 });
      expect(conflict).toMatchObject({ status: "conflict" });
      expect(applied).toBe(1);
      expect(records).toHaveLength(2);
      expect(
        () =>
          new ControlInbox({
            runId,
            journal: new RunStateJournal(runId, store, records.at(-1)?.sequence ?? 0),
            records,
            apply: async () => "applied",
          }),
      ).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("并发 applyPending 不重复应用同一控制", async () => {
    const runId = "concurrent-pending-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-concurrent-pending-"));
    const store = new FileRunStore(directory);
    const command = {
      schemaVersion: 1 as const,
      controlId: "approval-concurrent-pending",
      runId,
      type: "approval" as const,
      approvalId: "approval-concurrent-pending",
      decision: "allow" as const,
    };

    try {
      const initial = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async () => "accepted",
      });
      await initial.accept(command);
      const acceptedRecords = await store.read(runId);
      let applied = 0;
      const restored = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store, acceptedRecords.at(-1)?.sequence ?? 0),
        records: acceptedRecords,
        apply: async () => {
          applied += 1;
          return "applied";
        },
      });

      const [first, second] = await Promise.all([restored.applyPending(), restored.applyPending()]);
      const records = await store.read(runId);

      expect(first).toEqual([expect.objectContaining({ status: "applied", appliedSequence: 2 })]);
      expect(second).toEqual([]);
      expect(applied).toBe(1);
      expect(records).toHaveLength(2);
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
        {
          schemaVersion: 1,
          controlId: "disposition-invalid",
          runId,
          type: "delegation_disposition",
          delegationId: "delegation-1",
          action: "retry",
          reason: "不得自动重试",
        },
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

  it("Delegation Disposition 通过同一持久 ControlInbox 应用并可幂等恢复", async () => {
    const runId = "disposition-control-run" as RunId;
    const directory = await mkdtemp(path.join(tmpdir(), "coremind-control-disposition-"));
    const store = new FileRunStore(directory);
    const command = {
      schemaVersion: 1 as const,
      controlId: "disposition-control-1",
      runId,
      type: "delegation_disposition" as const,
      delegationId: "delegation-failed-1",
      action: "choose_alternative" as const,
      reason: "人工选择不重复原 Child Run 的替代路径",
    };
    let appliedCommand: unknown;
    try {
      const inbox = new ControlInbox({
        runId,
        journal: new RunStateJournal(runId, store),
        records: [],
        apply: async (accepted) => {
          appliedCommand = accepted;
          return "applied";
        },
      });

      expect(await inbox.accept(command)).toMatchObject({
        controlId: command.controlId,
        status: "applied",
      });
      expect(appliedCommand).toEqual(command);
      expect((await store.read(runId)).map((record) => record.kind)).toEqual([
        "control",
        "control",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
