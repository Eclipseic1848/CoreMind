import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recoveryDispositionFor, resolveToolCapability } from "coremind-tools";
import { describe, expect, it } from "vitest";
import { createEffectReceiptBinding } from "./effect-receipt-binding.js";
import type { LoopControllerSnapshot } from "./loop-controller.js";
import { DurableOperation } from "./operation-state.js";
import {
  FileRunStore,
  findUnsafeToolCall,
  fingerprintRunConfig,
  isRejectedAfterAbort,
  MemoryRunStore,
  prepareRunResume,
  RunStateJournal,
  type RunStateRecord,
} from "./run-state.js";
import type { CoreMindTraceEvent } from "./trace.js";

describe("RunState", () => {
  it("Telemetry 配置不参与 Resume 身份指纹", () => {
    const base = { schemaVersion: 2, name: "resume", agents: { main: { systemPrompt: "x" } } };

    expect(
      fingerprintRunConfig({
        ...base,
        telemetry: { mode: "FULL", endpoint: "https://one.example/v1" },
      }),
    ).toBe(
      fingerprintRunConfig({
        ...base,
        telemetry: { mode: "DISABLED", endpoint: "https://two.example/v1" },
      }),
    );
  });

  it("Store 在初始化时声明持久化能力，Memory 不能把内存可见伪装成 critical", async () => {
    const memory = new MemoryRunStore();
    const file = new FileRunStore(mkdtempSync(path.join(tmpdir(), "coremind-run-durability-")));

    expect(memory.supportedDurability).toEqual(["ordinary"]);
    expect(file.supportedDurability).toEqual(["ordinary", "critical"]);
    expect(file.durabilityBoundary).toBe("process_crash");

    const journal = new RunStateJournal("run-memory-critical", memory);
    journal.event({ type: "agent_start", agent: "main" });
    await expect(journal.flush("critical")).rejects.toMatchObject({
      code: "durability_unsupported",
    });
    expect(await memory.read("run-memory-critical")).toHaveLength(1);
  });

  it("旧 RunStore 保持 ordinary 兼容，但缺少 barrier 时不能升级为 critical", async () => {
    const records: RunStateRecord[] = [];
    const legacyStore = {
      append: async (item: RunStateRecord) => {
        records.push(item);
      },
      read: async () => structuredClone(records),
    };
    const journal = new RunStateJournal("run-legacy-store", legacyStore);
    journal.event({ legacy: true });

    await expect(journal.flush()).resolves.toMatchObject({
      requested: "ordinary",
      achieved: "ordinary",
      boundary: "process_memory",
    });
    await expect(journal.flush("critical")).rejects.toMatchObject({
      code: "durability_unsupported",
    });
  });

  it("读取旧记录时保留 eventId 缺失，不伪造 durability receipt", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-legacy-fact-"));
    const store = new FileRunStore(dir);
    const legacy = record(1, "event", { legacy: "0.3.1" });
    writeFileSync(store.pathFor(legacy.runId), `${JSON.stringify(legacy)}\n`, "utf8");

    const [loaded] = await store.read(legacy.runId);

    expect(loaded).toEqual(legacy);
    expect(loaded).not.toHaveProperty("eventId");
    expect(loaded).not.toHaveProperty("durability");
    expect(loaded).not.toHaveProperty("acknowledgement");
  });

  it("拒绝新记录中的空 eventId", async () => {
    const store = new MemoryRunStore();
    await expect(store.append({ ...record(1, "event", {}), eventId: " " })).rejects.toMatchObject({
      code: "run_state_corrupt",
    });
  });

  it("Journal 拒绝 Store 越权或降级的 critical acknowledgement", async () => {
    let unsupportedBarrierCalls = 0;
    const ordinaryOnly = {
      supportedDurability: ["ordinary"] as const,
      durabilityBoundary: "process_memory" as const,
      append: async (_item: RunStateRecord) => undefined,
      read: async () => [],
      barrier: async () => {
        unsupportedBarrierCalls += 1;
        return {
          requested: "critical" as const,
          achieved: "critical" as const,
          boundary: "process_crash" as const,
        };
      },
    };
    const unsupported = new RunStateJournal("run-ordinary-only", ordinaryOnly);
    unsupported.event({ unsafe: true });
    await expect(unsupported.flush("critical")).rejects.toMatchObject({
      code: "durability_unsupported",
    });
    expect(unsupportedBarrierCalls).toBe(0);

    const downgraded = {
      supportedDurability: ["ordinary", "critical"] as const,
      durabilityBoundary: "process_crash" as const,
      append: async (_item: RunStateRecord) => undefined,
      read: async () => [],
      barrier: async () => ({
        requested: "critical" as const,
        achieved: "ordinary" as const,
        boundary: "process_crash" as const,
      }),
    };
    const invalidAck = new RunStateJournal("run-downgraded-ack", downgraded);
    invalidAck.event({ unsafe: true });
    await expect(invalidAck.flush("critical")).rejects.toMatchObject({
      code: "durability_barrier_failed",
    });
  });

  it("critical barrier 只有在 Store 确认后成功，enqueue 成功不能冒充 committed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-barrier-fault-"));
    let failBarrier = true;
    const store = new FileRunStore(dir, {
      beforeBarrier: () => {
        if (failBarrier) throw new Error("injected barrier failure");
      },
    });
    const journal = new RunStateJournal("run-barrier-fault", store);
    journal.event({ type: "effect_receipt", status: "started", turnId: "turn-1" });

    await expect(journal.flush("critical")).rejects.toMatchObject({
      code: "durability_barrier_failed",
    });
    expect(await store.read("run-barrier-fault")).toHaveLength(1);

    failBarrier = false;
    await expect(journal.flush("critical")).resolves.toMatchObject({
      requested: "critical",
      achieved: "critical",
      boundary: "process_crash",
    });
    expect(journal.durabilityMetrics()).toEqual({
      ordinary: { succeeded: 0, failed: 0 },
      critical: { succeeded: 1, failed: 1 },
    });
  });

  it("critical barrier 与后续 append 共用 writer lock，Windows 不发生打开文件 rename 竞态", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-barrier-race-"));
    let releaseBarrier!: () => void;
    const barrierReleased = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let enterBarrier!: () => void;
    const barrierEntered = new Promise<void>((resolve) => {
      enterBarrier = resolve;
    });
    const store = new FileRunStore(dir, {
      beforeBarrier: async () => {
        enterBarrier();
        await barrierReleased;
      },
    });
    const journal = new RunStateJournal("run-barrier-race", store);
    journal.event({ order: 1 });
    const critical = journal.flush("critical");
    await barrierEntered;
    journal.event({ order: 2 });
    releaseBarrier();

    await critical;
    await journal.flush();
    expect((await store.read("run-barrier-race")).map((item) => item.payload)).toEqual([
      { order: 1 },
      { order: 2 },
    ]);
  });

  it("多个 File Store 争用同一 writer lock 时重试 Windows EPERM/EACCES", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-lock-contention-"));
    const runId = "run-lock-contention";
    const stores = Array.from(
      { length: 64 },
      () => new FileRunStore(dir, { lockTimeoutMs: 10_000 }),
    );
    await stores[0]!.append({
      ...record(1, "start", { configFingerprint: "same" }),
      runId,
    });

    await Promise.all(
      stores.map((store, index) =>
        index % 2 === 0 ? store.read(runId) : store.barrier(runId, "critical"),
      ),
    );

    expect(await stores[0]!.read(runId)).toHaveLength(1);
  });

  it("File Store critical ack 后进程立即退出，Windows/Linux 均可读取稳定 Fact 前缀", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-crash-probe-"));
    const repositoryRoot = process.env.INIT_CWD ?? process.cwd();
    const script = path.join(repositoryRoot, "scripts", "file-run-store-crash-probe.mjs");
    const child = spawnSync(process.execPath, [script, dir, "run-crash-probe"], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(child.status, child.stderr).toBe(86);
    const records = await new FileRunStore(dir).read("run-crash-probe");
    expect(records.map((item) => item.payload)).toEqual([
      { probe: "process-crash" },
      { type: "probe_fact", value: "critical-visible-after-exit" },
    ]);
  });

  it("File Store 持锁进程崩溃后回收 dead-owner lock，并保留已有稳定前缀", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-stale-lock-probe-"));
    const repositoryRoot = process.env.INIT_CWD ?? process.cwd();
    const script = path.join(repositoryRoot, "scripts", "file-run-store-crash-probe.mjs");
    const child = spawnSync(process.execPath, [script, dir, "run-stale-lock-probe", "lock-crash"], {
      encoding: "utf8",
      windowsHide: true,
    });

    expect(child.status, child.stderr).toBe(87);
    const [left, right] = await Promise.all([
      new FileRunStore(dir).read("run-stale-lock-probe"),
      new FileRunStore(dir).read("run-stale-lock-probe"),
    ]);
    expect(right).toEqual(left);
    const records = left;
    expect(records.map((item) => item.payload)).toEqual([{ probe: "process-crash" }]);
  });

  it("无法证明 owner 已死亡的空白或异常 lock 不会被自动删除", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-invalid-lock-"));
    const lockPath = path.join(dir, "run-invalid-lock.jsonl.lock");
    writeFileSync(lockPath, "", "utf8");

    await expect(
      new FileRunStore(dir, { lockTimeoutMs: 20 }).read("run-invalid-lock"),
    ).rejects.toMatchObject({ code: "run_state_locked" });
    expect(readFileSync(lockPath, "utf8")).toBe("");
  });

  it("拒绝持久化结果轴枚举非法的 tool_lifecycle Fact", async () => {
    const store = new MemoryRunStore();
    const invalid = traceRecord(1, 1, {
      type: "tool_lifecycle",
      agent: "main",
      tool: "write",
      callId: "call-invalid-lifecycle",
      resolution: {
        phase: "call_recorded",
        status: "completed",
        result: { effectState: "maybe" },
      },
    });

    await expect(store.append(invalid)).rejects.toMatchObject({ code: "run_state_corrupt" });
  });

  it("拒绝持久化字段缺失的 capability_resolved 安全事实", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-capability-"));
    const store = new FileRunStore(dir);
    const invalid = traceRecord(1, 1, {
      type: "capability_resolved",
      agent: "main",
      tool: "read",
      callId: "call-invalid",
      capability: { effect: "none" },
      recoveryDisposition: "replay_safe",
    });

    await expect(store.append(invalid)).rejects.toMatchObject({ code: "run_state_corrupt" });
  });

  it.each([
    {
      name: "恢复处置与 replay 不一致",
      capability: {
        tool: "read",
        effect: "none",
        replay: "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
        source: "builtin",
        resolution: "resolved",
        issues: [],
      },
      recoveryDisposition: "requires_human",
    },
    {
      name: "fallback 未采用最严格能力元组",
      capability: {
        tool: "read",
        effect: "none",
        replay: "safe",
        concurrency: "parallel",
        checkpoint: "none",
        durability: "ordinary",
        source: "fallback",
        resolution: "fallback",
        issues: ["capability_missing"],
      },
      recoveryDisposition: "replay_safe",
    },
  ])("拒绝持久化$name的 capability_resolved", async ({ capability, recoveryDisposition }) => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-capability-consistency-"));
    const store = new FileRunStore(dir);
    const invalid = traceRecord(1, 1, {
      type: "capability_resolved",
      agent: "main",
      tool: "read",
      callId: "call-inconsistent",
      capability,
      recoveryDisposition,
    });

    await expect(store.append(invalid)).rejects.toMatchObject({ code: "run_state_corrupt" });
  });

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

  it("只修复已有完整记录之后的 torn tail，不吞掉整文件损坏", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-torn-"));
    const store = new FileRunStore(dir);
    const valid = record(1, "start", { configFingerprint: "same" });
    writeFileSync(store.pathFor("run-restore"), `${JSON.stringify(valid)}\n{"version":1`, "utf8");

    await expect(store.read("run-restore")).resolves.toEqual([valid]);
    expect(readFileSync(store.pathFor("run-restore"), "utf8")).toBe(`${JSON.stringify(valid)}\n`);
  });

  it("末行 JSON 完整但字段非法时失败关闭，不能当作 torn tail 删除", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-semantic-tail-"));
    const store = new FileRunStore(dir);
    const valid = record(1, "start", { configFingerprint: "same" });
    const invalid = { ...record(2, "event", { type: "agent_start" }), sequence: 99 };
    const original = `${JSON.stringify(valid)}\n${JSON.stringify(invalid)}`;
    writeFileSync(store.pathFor("run-restore"), original, "utf8");

    await expect(store.read("run-restore")).rejects.toMatchObject({ code: "run_state_corrupt" });
    expect(readFileSync(store.pathFor("run-restore"), "utf8")).toBe(original);
  });

  it("原子提交前故障不改变旧文件，重试后只追加一次", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-fault-"));
    const initial = new FileRunStore(dir);
    await initial.append(record(1, "start", { configFingerprint: "same" }));
    let fail = true;
    const injected = new FileRunStore(dir, {
      beforeCommit: () => {
        if (fail) throw new Error("injected crash");
      },
    });
    const next = record(2, "event", { type: "agent_start" });

    await expect(injected.append(next)).rejects.toThrow("injected crash");
    expect(await initial.read("run-restore")).toHaveLength(1);
    fail = false;
    await injected.append(next);
    await injected.append(next);
    expect((await initial.read("run-restore")).map((item) => item.sequence)).toEqual([1, 2]);
  });

  it("两个 writer 的冲突不会造成丢记录或非法序号", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-writers-"));
    const left = new FileRunStore(dir);
    const right = new FileRunStore(dir);
    await left.append(record(1, "start", { configFingerprint: "same" }));

    const results = await Promise.allSettled([
      left.append(record(2, "event", { writer: "left" })),
      right.append(record(2, "event", { writer: "right" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await left.read("run-restore")).map((item) => item.sequence)).toEqual([1, 2]);
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

  it("保存 operation 状态并在恢复计划中返回同一权威快照", async () => {
    const store = new MemoryRunStore();
    const journal = new RunStateJournal("run-operation", store);
    const operation = DurableOperation.create({
      runId: "run-operation",
      operationId: "operation-1",
      eventId: "accepted-1",
    });

    await journal.start({ configFingerprint: "fingerprint", initialPrompt: "开始" });
    journal.operation(operation.records()[0]!);
    journal.operation(operation.transition({ eventId: "start-1", type: "START" }).record!);
    journal.operation(
      operation.transition({ eventId: "pause-1", type: "PAUSE", reason: "approval" }).record!,
    );
    journal.pause({ outcome: { status: "paused" } });
    await journal.flush();

    const plan = prepareRunResume(await store.read("run-operation"), "fingerprint");
    expect(plan.operationSnapshot).toEqual(operation.snapshot());
    expect(plan.operationRecords).toEqual(operation.records());
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

  it("恢复计划按实际落盘顺序校验，拒绝被重新排列的记录", () => {
    const records: RunStateRecord[] = [
      record(2, "event", { type: "agent_start" }),
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
    ];

    expect(() => prepareRunResume(records, "fingerprint")).toThrowError(
      expect.objectContaining({ code: "run_state_corrupt" }),
    );
  });

  it("未进入执行阶段的副作用不阻止恢复", () => {
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
        status: "not_started",
        stepId: "s1",
      }),
    ];

    expect(() => prepareRunResume(records, "fingerprint")).not.toThrow();
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

  it("0.3.0 历史 RunState（start 无会话树水位字段）仍可恢复读取，不报 corrupt", () => {
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
        status: "not_started",
        stepId: "s1",
      }),
      record(4, "pause", { reason: "process_interrupted" }),
    ];

    const plan = prepareRunResume(records, "fingerprint");

    // 无 sessionSeqStart / turnSeqStart 的旧数据正常恢复；跨轮归属按规格 01 §2.3 声明不可回答
    expect(plan.runId).toBe("run-restore");
    expect(plan.nextJournalSequence).toBe(4);
  });

  it("0.3.0 run 文件（含压缩事件、无会话树引用）从磁盘读取不报 corrupt（A-3）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-run-state-legacy-"));
    const store = new FileRunStore(dir);
    // 0.3.0 生成的 run 文件：start 无 sessionSeqStart；context_compacted 事件无 sessionEntryId 引用
    const records: RunStateRecord[] = [
      record(1, "start", { configFingerprint: "fingerprint", initialPrompt: "开始" }),
      traceRecord(2, 1, {
        type: "context_compacted",
        beforeTokens: 100,
        afterTokens: 50,
        removedMessages: 3,
        strategy: "deterministic-v1",
        reason: "threshold",
        summaryFingerprint: `${"0".repeat(64)}`,
      }),
      record(3, "finish", { status: "succeeded" }),
    ];
    writeFileSync(
      store.pathFor("run-restore"),
      `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );

    const parsed = await store.read("run-restore");
    expect(parsed.map((item) => item.kind)).toEqual(["start", "event", "finish"]);
    const compacted = parsed[1]!.payload as CoreMindTraceEvent;
    expect(compacted.event.type).toBe("context_compacted");
    // 0.3.0 的压缩事件只带指纹，不携带会话树引用；读取不因缺字段报 corrupt
    expect("sessionEntryId" in compacted.event).toBe(false);
    // 已结束运行按语义拒绝恢复（run_already_finished），而非判为损坏
    expect(() => prepareRunResume(parsed, "fingerprint")).toThrowError(
      expect.objectContaining({ code: "run_already_finished" }),
    );
  });
});

describe("RunStateJournal 事件准入（取消收敛）", () => {
  it.each(["pause", "finish"] as const)(
    "markAborted 后 operation/loop 与唯一 %s 终态放行",
    async (terminalKind) => {
      const store = new MemoryRunStore();
      const runId = `run-admit-${terminalKind}`;
      const journal = new RunStateJournal(runId, store);
      await journal.start({ configFingerprint: "fingerprint" });

      journal.markAborted();
      journal.operation({ type: "operation" });
      journal.loop({ phase: "failed" } as never);
      if (terminalKind === "pause") journal.pause({ reason: "aborted" });
      else journal.finish({ outcome: { status: "aborted" } });
      await journal.flush();

      const records = await store.read(runId);
      expect(records.map((item) => item.kind)).toEqual([
        "start",
        "operation",
        "loop",
        terminalKind,
      ]);
    },
  );

  it("markAborted 后终态类事件（tool_result/turn_end）被拒绝写入并计数，不抛错", async () => {
    const store = new MemoryRunStore();
    const journal = new RunStateJournal("run-admit", store);
    await journal.start({ configFingerprint: "fingerprint" });

    journal.markAborted();
    journal.event(traceEvent(1, { type: "turn_end", agent: "main" }));
    journal.event(
      traceEvent(2, { type: "tool_result", agent: "main", tool: "read", isError: false }),
    );
    await journal.flush();

    const records = await store.read("run-admit");
    expect(records.map((item) => item.kind)).toEqual(["start"]);
    expect(journal.rejectedAfterAbort()).toBe(2);
  });

  it("分界前已启动活动的 effect_receipt 终态放行（R3），迟到无归属收据拒绝", async () => {
    const store = new MemoryRunStore();
    const journal = new RunStateJournal("run-admit", store);
    await journal.start({ configFingerprint: "fingerprint" });
    journal.markAborted(new Set(["turn-0"]));

    // 分界前启动的活动（turn-0 已在 trace 中）→ 放行
    journal.event(
      traceEvent(1, {
        type: "effect_receipt",
        idempotencyKey: "r:1",
        tool: "write",
        status: "committed",
        stepId: "s0",
        turnId: "turn-0",
      }),
    );
    // 迟到且无归属（无法证明属于分界前活动）→ 拒绝
    journal.event(
      traceEvent(2, {
        type: "effect_receipt",
        idempotencyKey: "r:2",
        tool: "write",
        status: "committed",
      }),
    );
    // abort 后才生成的活动 → 拒绝
    journal.event(
      traceEvent(3, {
        type: "effect_receipt",
        idempotencyKey: "r:3",
        tool: "write",
        status: "started",
        turnId: "turn-99",
      }),
    );
    await journal.flush();

    const records = await store.read("run-admit");
    expect(records.map((item) => item.kind)).toEqual(["start", "event"]);
    expect(journal.rejectedAfterAbort()).toBe(2);
  });

  it("markAborted 后非终态事件（text_delta/approval_required/error）放行", async () => {
    const store = new MemoryRunStore();
    const journal = new RunStateJournal("run-admit", store);
    await journal.start({ configFingerprint: "fingerprint" });

    journal.markAborted();
    journal.event(traceEvent(1, { type: "text_delta", agent: "main", delta: "迟到增量" }));
    journal.event(
      traceEvent(2, {
        type: "approval_required",
        approvalId: "a1",
        runId: "run-admit",
        agent: "main",
        tool: "write",
        args: {},
        risk: "low",
        effect: {
          severity: "low",
          type: "write",
          paths: ["x"],
          reversible: true,
          description: "写",
        },
      }),
    );
    journal.event(traceEvent(3, { type: "error", message: "x", fatal: false }));
    await journal.flush();

    const records = await store.read("run-admit");
    expect(records.filter((item) => item.kind === "event")).toHaveLength(3);
    expect(journal.rejectedAfterAbort()).toBe(0);
  });
});

function traceEvent(sequence: number, event: Record<string, unknown>): CoreMindTraceEvent {
  return {
    eventId: `event-${sequence}`,
    runId: "run-admit",
    sequence,
    timestamp: new Date().toISOString(),
    event,
  } as unknown as CoreMindTraceEvent;
}

describe("isRejectedAfterAbort 分支覆盖", () => {
  it("payload 非对象或 event 非对象时放行", () => {
    expect(isRejectedAfterAbort(null, new Set())).toBe(false);
    expect(isRejectedAfterAbort(42, new Set())).toBe(false);
    expect(isRejectedAfterAbort({ event: "not-object" }, new Set())).toBe(false);
  });

  it("effect_receipt status 缺失或 not_started 时放行", () => {
    expect(isRejectedAfterAbort({ event: { type: "effect_receipt" } }, new Set())).toBe(false);
    expect(
      isRejectedAfterAbort(
        { event: { type: "effect_receipt", status: "not_started", turnId: "t1" } },
        new Set(),
      ),
    ).toBe(false);
  });

  it("knownTurnIds 为空时无归属与有归属的收据均拒绝；命中集合放行", () => {
    expect(
      isRejectedAfterAbort(
        { event: { type: "effect_receipt", status: "committed", turnId: "t1" } },
        undefined,
      ),
    ).toBe(true);
    expect(
      isRejectedAfterAbort(
        { event: { type: "effect_receipt", status: "committed", turnId: "t1" } },
        new Set(["t1"]),
      ),
    ).toBe(false);
  });

  it("tool_result / turn_end 一律拒绝；其他类型放行", () => {
    expect(isRejectedAfterAbort({ event: { type: "tool_result" } }, new Set())).toBe(true);
    expect(isRejectedAfterAbort({ event: { type: "turn_end" } }, new Set())).toBe(true);
    expect(isRejectedAfterAbort({ event: { type: "text_delta", delta: "x" } }, new Set())).toBe(
      false,
    );
    expect(isRejectedAfterAbort({ event: { type: "approval_required" } }, new Set())).toBe(false);
  });
});

describe("findUnsafeToolCall（resumable 安全门单点实现）", () => {
  it("started Receipt 不被较早 lifecycle 的 not_started 覆盖，崩溃前缀必须人工处置", () => {
    const identity = { agent: "main", tool: "write", callId: "call-crash" };
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        ...identity,
        idempotencyKey: "run-restore:call-crash",
      }),
      traceEntry(2, {
        type: "tool_lifecycle",
        ...identity,
        resolution: { phase: "call_recorded", status: "completed" },
      }),
      traceEntry(3, {
        type: "tool_lifecycle",
        ...identity,
        resolution: {
          phase: "capability_resolved",
          status: "completed",
          result: { recoveryDisposition: "requires_human" },
        },
      }),
      ...["policy_resolved", "approval_resolved", "lease_acquired", "checkpoint_durable"].map(
        (phase, index) =>
          traceEntry(index + 4, {
            type: "tool_lifecycle",
            ...identity,
            resolution: { phase, status: "completed" },
          }),
      ),
      traceEntry(8, {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "run-restore:call-crash",
        status: "started",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({
      tool: "write",
      idempotencyKey: "run-restore:call-crash",
      receiptStatus: "unknown",
    });
  });

  it("混合历史与 lifecycle Trace 时仍检查 legacy 不安全 Call", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "legacy",
        tool: "send_email",
        callId: "legacy-unsafe",
      }),
      traceEntry(2, {
        type: "tool_lifecycle",
        agent: "main",
        tool: "read",
        callId: "current-safe",
        resolution: { phase: "call_recorded", status: "completed" },
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({ tool: "send_email" });
  });

  it("优先使用 lifecycle 正交轴阻止 unknown Effect 自动恢复", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_lifecycle",
        agent: "main",
        tool: "write",
        callId: "call-lifecycle",
        resolution: { phase: "call_recorded", status: "completed" },
      }),
      traceEntry(2, {
        type: "tool_lifecycle",
        agent: "main",
        tool: "write",
        callId: "call-lifecycle",
        resolution: {
          phase: "capability_resolved",
          status: "completed",
          result: { recoveryDisposition: "requires_human" },
        },
      }),
      ...[
        "policy_resolved",
        "approval_resolved",
        "lease_acquired",
        "checkpoint_durable",
        "started_durable",
        "executing",
      ].map((phase, index) =>
        traceEntry(index + 3, {
          type: "tool_lifecycle",
          agent: "main",
          tool: "write",
          callId: "call-lifecycle",
          resolution: { phase, status: "completed" },
        }),
      ),
      traceEntry(10, {
        type: "tool_lifecycle",
        agent: "main",
        tool: "write",
        callId: "call-lifecycle",
        resolution: {
          phase: "observed",
          status: "completed",
          result: { executionOutcome: "timed_out", effectState: "unknown" },
        },
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({
      tool: "write",
      receiptStatus: "unknown",
    });
  });

  it("历史记录缺少 Capability Fact 时不能按 read 名称推断为安全", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "read",
        callId: "call-read-legacy",
        idempotencyKey: "r:1",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({ tool: "read" });
  });

  it("匹配 replay_safe Capability Fact 的本地读取不阻塞恢复", () => {
    const capability = resolveToolCapability({ tool: "read" });
    const trace = [
      traceEntry(1, {
        type: "capability_resolved",
        agent: "main",
        tool: "read",
        callId: "call-read-current",
        capability,
        recoveryDisposition: recoveryDispositionFor(capability),
      }),
      traceEntry(2, {
        type: "tool_call",
        agent: "main",
        tool: "read",
        callId: "call-read-current",
        idempotencyKey: "r:1",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toBeUndefined();
  });

  it("外部读取不能按 web-fetch 名称推断为 replay-safe", () => {
    const capability = resolveToolCapability({ tool: "web-fetch" });
    const trace = [
      traceEntry(1, {
        type: "capability_resolved",
        agent: "main",
        tool: "web-fetch",
        callId: "call-web-fetch",
        capability,
        recoveryDisposition: recoveryDispositionFor(capability),
      }),
      traceEntry(2, {
        type: "tool_call",
        agent: "main",
        tool: "web-fetch",
        callId: "call-web-fetch",
        idempotencyKey: "r:2",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({ tool: "web-fetch" });
  });

  it("同一 ReceiptId 改绑参数时恢复判定失败关闭", () => {
    const binding = {
      version: 1 as const,
      runId: "run-restore",
      turnId: "turn-1",
      agent: "main",
      callId: "call-web-fetch",
      tool: "web-fetch",
      argumentsFingerprint: "a".repeat(64),
      capabilityFingerprint: "b".repeat(64),
    };
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "web-fetch",
        args: { url: "https://example.invalid" },
        callId: "call-web-fetch",
        turnId: "turn-1",
        idempotencyKey: "run-restore:call-web-fetch",
      }),
      traceEntry(2, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:call-web-fetch",
        tool: "web-fetch",
        status: "started",
        agent: "main",
        callId: "call-web-fetch",
        turnId: "turn-1",
        binding,
      }),
      traceEntry(3, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:call-web-fetch",
        tool: "web-fetch",
        status: "unknown",
        agent: "main",
        callId: "call-web-fetch",
        turnId: "turn-1",
        binding: { ...binding, argumentsFingerprint: "c".repeat(64) },
      }),
    ];

    expect(() => findUnsafeToolCall(trace)).toThrowError(
      expect.objectContaining({ code: "effect_receipt_conflict" }),
    );
  });

  it("Receipt 指纹与原始 Call 事实不一致时恢复判定失败关闭", () => {
    const capability = resolveToolCapability({ tool: "web-fetch" });
    const binding = createEffectReceiptBinding({
      runId: "run-restore",
      turnId: "turn-1",
      agent: "main",
      callId: "call-web-fetch",
      tool: "web-fetch",
      args: { url: "https://forged.invalid" },
      capability,
    });
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "web-fetch",
        args: { url: "https://actual.invalid" },
        callId: "call-web-fetch",
        turnId: "turn-1",
        idempotencyKey: "run-restore:call-web-fetch",
      }),
      traceEntry(2, {
        type: "capability_resolved",
        agent: "main",
        tool: "web-fetch",
        callId: "call-web-fetch",
        capability,
        recoveryDisposition: recoveryDispositionFor(capability),
      }),
      traceEntry(3, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:call-web-fetch",
        tool: "web-fetch",
        status: "started",
        agent: "main",
        callId: "call-web-fetch",
        turnId: "turn-1",
        binding,
      }),
      traceEntry(4, {
        type: "effect_receipt",
        idempotencyKey: "run-restore:call-web-fetch",
        tool: "web-fetch",
        status: "unknown",
        agent: "main",
        callId: "call-web-fetch",
        turnId: "turn-1",
        binding,
      }),
    ];

    expect(() => findUnsafeToolCall(trace)).toThrowError(
      expect.objectContaining({ code: "effect_receipt_conflict" }),
    );
  });

  it("not_started 收据视为安全", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        idempotencyKey: "r:1",
      }),
      traceEntry(2, {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "r:1",
        status: "not_started",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toBeUndefined();
  });

  it("没有收据的非安全工具视为不安全", () => {
    const trace = [traceEntry(1, { type: "tool_call", agent: "main", tool: "send_email" })];

    expect(findUnsafeToolCall(trace)).toMatchObject({ tool: "send_email" });
  });

  it("步骤完成后不再视为不安全（即使收据已提交）", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        idempotencyKey: "r:1",
        stepId: "s1",
      }),
      traceEntry(2, {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "r:1",
        status: "committed",
        stepId: "s1",
      }),
      traceEntry(3, { type: "step_output", stepId: "s1", agent: "main", text: "完成" }),
    ];

    expect(findUnsafeToolCall(trace)).toBeUndefined();
  });

  it("已提交副作用在步骤未稳定完成时返回收据状态", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        idempotencyKey: "r:1",
        stepId: "s1",
      }),
      traceEntry(2, {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "r:1",
        status: "committed",
        stepId: "s1",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({
      tool: "write",
      idempotencyKey: "r:1",
      receiptStatus: "committed",
    });
  });

  it("unknown 收据返回收据状态供调用方区分报错", () => {
    const trace = [
      traceEntry(1, {
        type: "tool_call",
        agent: "main",
        tool: "write",
        idempotencyKey: "r:1",
      }),
      traceEntry(2, {
        type: "effect_receipt",
        tool: "write",
        idempotencyKey: "r:1",
        status: "unknown",
      }),
    ];

    expect(findUnsafeToolCall(trace)).toMatchObject({ receiptStatus: "unknown" });
  });
});

function traceEntry(sequence: number, event: Record<string, unknown>): CoreMindTraceEvent {
  return {
    eventId: `event-${sequence}`,
    runId: "run-restore",
    sequence,
    timestamp: new Date().toISOString(),
    event,
  } as unknown as CoreMindTraceEvent;
}

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
