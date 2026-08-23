import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FactLedger } from "./fact-ledger.js";
import {
  FileRunStore,
  MemoryRunStore,
  type RunStateRecord,
  type RunStore,
  type RunStoreDurability,
  type RunStoreDurabilityAcknowledgement,
} from "./run-state.js";

describe("FactLedger", () => {
  it("critical append 返回绑定单条 Fact 的 sequence/eventId/level/Store acknowledgement", async () => {
    const store = new ExactCommitStore();
    const ledger = new FactLedger("run-receipt", store);

    const receipt = await ledger.append("event", { value: "critical" }, { durability: "critical" });

    expect(receipt).toMatchObject({
      runId: "run-receipt",
      sequence: 1,
      kind: "event",
      durability: "critical",
      acknowledgement: {
        requested: "critical",
        achieved: "critical",
        boundary: "process_crash",
      },
    });
    expect(receipt.eventId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(store.commits).toEqual([
      expect.objectContaining({
        durability: "critical",
        record: expect.objectContaining({ sequence: 1, kind: "event" }),
      }),
    ]);
  });

  it("critical receipt 在 Store acknowledgement 完成前保持 pending", async () => {
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const store = new ExactCommitStore(async () => acknowledgement);
    const ledger = new FactLedger("run-pending", store);
    let settled = false;

    const append = ledger
      .append("event", { value: "pending" }, { durability: "critical" })
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(ledger.metrics()).toMatchObject({ pending: 1 });
    acknowledge();
    await expect(append).resolves.toMatchObject({ sequence: 1, durability: "critical" });
    expect(ledger.metrics()).toMatchObject({ pending: 0, critical: { succeeded: 1, failed: 0 } });
  });

  it("一次 commit 失败后显式 poisoned，后续写入不执行且不跳过稳定 sequence", async () => {
    const store = new ExactCommitStore(async (_record, _durability, attempt) => {
      if (attempt === 1) throw new Error("commit failed");
    });
    const ledger = new FactLedger("run-poisoned", store);

    await expect(ledger.append("event", { value: 1 })).rejects.toThrow("commit failed");
    await expect(ledger.append("event", { value: 2 })).rejects.toMatchObject({
      code: "fact_ledger_poisoned",
    });

    expect(store.commits).toHaveLength(1);
    expect(await store.read("run-poisoned")).toEqual([]);
    expect(ledger.status()).toMatchObject({ state: "poisoned", failedSequence: 1 });
  });

  it("并发队列的首次失败保留根因并清零 pending", async () => {
    const rootCause = new Error("first commit failed");
    const store = new ExactCommitStore(async () => {
      throw rootCause;
    });
    const ledger = new FactLedger("run-queued-poison", store);

    const settled = await Promise.allSettled([
      ledger.append("event", { value: 1 }),
      ledger.append("event", { value: 2 }),
    ]);

    expect(settled[0]).toMatchObject({ status: "rejected", reason: rootCause });
    expect(settled[1]).toMatchObject({
      status: "rejected",
      reason: { code: "fact_ledger_poisoned" },
    });
    await expect(ledger.flush()).rejects.toBe(rootCause);
    expect(store.commits).toHaveLength(1);
    expect(ledger.metrics()).toMatchObject({ pending: 0, ordinary: { failed: 1 } });
    expect(ledger.status()).toMatchObject({ state: "poisoned", failedSequence: 1 });
  });

  it("并发 append 按预留 sequence 串行提交并返回各自 receipt", async () => {
    const store = new ExactCommitStore();
    const ledger = new FactLedger("run-order", store);

    const receipts = await Promise.all(
      Array.from({ length: 20 }, (_, index) => ledger.append("event", { index })),
    );

    expect(receipts.map((receipt) => receipt.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect((await store.read("run-order")).map((record) => record.sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
  });

  it.each(["pause", "finish"] as const)("%s 终态 Fact 成功后拒绝新的活动 Fact", async (kind) => {
    const ledger = new FactLedger(`run-terminal-${kind}`, new ExactCommitStore());
    await ledger.append(kind, { outcome: { status: kind } }, { durability: "critical" });

    await expect(ledger.append("event", { late: true })).rejects.toMatchObject({
      code: "fact_ledger_terminal",
    });
  });

  it("Memory 只产生 ordinary receipt，critical 失败关闭", async () => {
    const ledger = new FactLedger("run-memory", new MemoryRunStore());

    await expect(ledger.append("event", { ordinary: true })).resolves.toMatchObject({
      sequence: 1,
      durability: "ordinary",
      acknowledgement: { achieved: "ordinary", boundary: "process_memory" },
    });
    await expect(
      ledger.append("event", { critical: true }, { durability: "critical" }),
    ).rejects.toMatchObject({ code: "durability_unsupported" });
  });

  it("旧 Store 可继续 ordinary append，但不能伪造 critical receipt", async () => {
    const records: RunStateRecord[] = [];
    const legacyStore: RunStore = {
      append: async (record) => {
        records.push(structuredClone(record));
      },
      read: async () => structuredClone(records),
    };
    const ordinary = new FactLedger("run-legacy-ordinary", legacyStore);

    await expect(ordinary.append("event", { legacy: true })).resolves.toMatchObject({
      durability: "ordinary",
      acknowledgement: { achieved: "ordinary", boundary: "process_memory" },
    });

    const critical = new FactLedger("run-legacy-critical", legacyStore);
    await expect(
      critical.append("event", { unsafe: true }, { durability: "critical" }),
    ).rejects.toMatchObject({ code: "durability_unsupported" });
  });

  it("拒绝 Store 返回的降级或不匹配 acknowledgement", async () => {
    const store: RunStore = {
      supportedDurability: ["ordinary", "critical"],
      durabilityBoundary: "process_crash",
      append: async () => undefined,
      commit: async () => ({
        requested: "critical",
        achieved: "ordinary",
        boundary: "process_crash",
      }),
      read: async () => [],
    };
    const ledger = new FactLedger("run-invalid-ack", store);

    await expect(
      ledger.append("event", { unsafe: true }, { durability: "critical" }),
    ).rejects.toMatchObject({ code: "durability_barrier_failed" });
    expect(ledger.status()).toMatchObject({ state: "poisoned", failedSequence: 1 });
  });

  it("File critical commit 在 barrier 故障时不发布未确认 Fact", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-fact-ledger-commit-"));
    const store = new FileRunStore(directory, {
      beforeBarrier: () => {
        throw new Error("injected sync failure");
      },
    });
    const ledger = new FactLedger("run-file-fault", store);

    await expect(
      ledger.append("event", { unsafe: true }, { durability: "critical" }),
    ).rejects.toMatchObject({ code: "durability_barrier_failed" });
    expect(await new FileRunStore(directory).read("run-file-fault")).toEqual([]);
  });

  it("重试同一 critical Fact 会重新达到 Store barrier 后才确认", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-fact-ledger-idempotent-"));
    let barriers = 0;
    const store = new FileRunStore(directory, {
      beforeBarrier: () => {
        barriers += 1;
      },
    });
    const record: RunStateRecord = {
      version: 1,
      runId: "run-idempotent-critical",
      sequence: 1,
      eventId: "event-idempotent-critical",
      timestamp: new Date().toISOString(),
      kind: "event",
      payload: { value: "same" },
    };

    await store.commit(record, "critical");
    await store.commit(structuredClone(record), "critical");

    expect(barriers).toBe(2);
    expect(await store.read(record.runId)).toEqual([record]);
  });

  it("统计分级 acknowledgement 延迟", async () => {
    const ledger = new FactLedger("run-latency", new ExactCommitStore());

    const receipt = await ledger.append("event", { measured: true }, { durability: "critical" });

    expect(receipt.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ledger.metrics().critical).toMatchObject({
      succeeded: 1,
      failed: 0,
      totalLatencyMs: receipt.latencyMs,
      maxLatencyMs: receipt.latencyMs,
    });
  });

  it.each(["enqueue", "write", "rename_commit", "flush", "ack"] as const)(
    "Fake Store 在 %s 故障点失败后 poison ledger",
    async (faultPoint) => {
      const store = new FaultPointStore(faultPoint);
      const ledger = new FactLedger(`run-fault-${faultPoint}`, store);

      await expect(
        ledger.append("event", { faultPoint }, { durability: "critical" }),
      ).rejects.toThrow(faultPoint);
      await expect(ledger.append("event", { later: true })).rejects.toMatchObject({
        code: "fact_ledger_poisoned",
      });

      expect(store.attempts).toBe(1);
      expect(ledger.status()).toMatchObject({ state: "poisoned", failedSequence: 1 });
      expect(await store.read(ledger.runId)).toHaveLength(faultPoint === "ack" ? 1 : 0);
    },
  );
});

type CommitFaultPoint = "enqueue" | "write" | "rename_commit" | "flush" | "ack";

class FaultPointStore implements RunStore {
  readonly supportedDurability = ["ordinary", "critical"] as const;
  readonly durabilityBoundary = "process_crash" as const;
  readonly records: RunStateRecord[] = [];
  attempts = 0;

  constructor(private readonly faultPoint: CommitFaultPoint) {}

  async append(record: RunStateRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }

  async commit(
    record: RunStateRecord,
    durability: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    this.attempts += 1;
    for (const phase of ["enqueue", "write", "rename_commit", "flush"] as const) {
      if (this.faultPoint === phase) throw new Error(`fault at ${phase}`);
    }
    this.records.push(structuredClone(record));
    if (this.faultPoint === "ack") throw new Error("fault at ack");
    return {
      requested: durability,
      achieved: durability,
      boundary: this.durabilityBoundary,
    };
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    return structuredClone(this.records.filter((record) => record.runId === runId));
  }
}

class ExactCommitStore implements RunStore {
  readonly supportedDurability = ["ordinary", "critical"] as const;
  readonly durabilityBoundary = "process_crash" as const;
  readonly records: RunStateRecord[] = [];
  readonly commits: Array<{ record: RunStateRecord; durability: RunStoreDurability }> = [];
  private attempts = 0;

  constructor(
    private readonly beforeCommit?: (
      record: RunStateRecord,
      durability: RunStoreDurability,
      attempt: number,
    ) => Promise<void> | void,
  ) {}

  async append(record: RunStateRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }

  async commit(
    record: RunStateRecord,
    durability: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    this.attempts += 1;
    this.commits.push({ record: structuredClone(record), durability });
    await this.beforeCommit?.(record, durability, this.attempts);
    this.records.push(structuredClone(record));
    return {
      requested: durability,
      achieved: durability,
      boundary: this.durabilityBoundary,
    };
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    return structuredClone(this.records.filter((record) => record.runId === runId));
  }
}
