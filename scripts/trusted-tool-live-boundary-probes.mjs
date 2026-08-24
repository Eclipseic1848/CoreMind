import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CheckpointManager } from "../packages/coremind-runtime/dist/checkpoint.js";
import { FileRunStore, RunStateJournal } from "../packages/coremind-runtime/dist/run-state.js";
import { ToolExecutionEngine } from "../packages/coremind-runtime/dist/tool-call-lifecycle.js";
import { WorkspaceLeaseService } from "../packages/coremind-runtime/dist/workspace-lease.js";
import { performActualToolEffect } from "./trusted-tool-fault-probes.mjs";

const OWNED_CRASH_KINDS = new Set(["process_crash", "owner_exit"]);
const POINT_ORDER = [
  "call_fact",
  "capability",
  "policy",
  "approval",
  "lease",
  "checkpoint",
  "started_barrier",
  "adapter",
  "effect_terminal",
  "result_barrier",
  "cleanup",
  "journal_flush",
  "run_terminal",
];

export async function runLiveBoundaryProbe(scenario, workspaceRoot, tracker, options = {}) {
  if (OWNED_CRASH_KINDS.has(scenario.kind)) return undefined;
  const probeRoot = path.join(workspaceRoot, `live-boundary-${scenario.seed}`);
  const scenarioWorkspace = path.join(probeRoot, "workspace");
  const stateDirectory = path.join(probeRoot, "run-state");
  const checkpointRoot = path.join(scenarioWorkspace, ".coremind", "checkpoints");
  const checkpointTarget = path.join(scenarioWorkspace, "checkpoint-target.txt");
  await mkdir(stateDirectory, { recursive: true });
  await mkdir(scenarioWorkspace, { recursive: true });
  await writeFile(checkpointTarget, "before", "utf8");

  const runId = `live-boundary-run-${scenario.seed}`;
  const callId = `live-boundary-call-${scenario.seed}`;
  const identity = { agent: "main", stepId: "fault-step", callId };
  const fileStore = new FileRunStore(stateDirectory, options.fileRunStoreOptions);
  let storeFault;
  const store = {
    get supportedDurability() {
      return storeFault === "store_unsupported" ? ["ordinary"] : fileStore.supportedDurability;
    },
    durabilityBoundary: fileStore.durabilityBoundary,
    append: async (record) => {
      if (storeFault === "store_failure") {
        throw Object.assign(new Error("集成 File Store commit failure"), {
          code: "injected_store_failure",
        });
      }
      await fileStore.append(record);
    },
    commit: async (record, durability) => {
      if (storeFault === "store_failure") {
        throw Object.assign(new Error("集成 File Store commit failure"), {
          code: "injected_store_failure",
        });
      }
      return fileStore.commit(record, durability);
    },
    barrier: (targetRunId, durability) => fileStore.barrier(targetRunId, durability),
    read: (targetRunId) => fileStore.read(targetRunId),
  };
  const journal = new RunStateJournal(runId, store);
  const checkpointManager = new CheckpointManager({
    cwd: scenarioWorkspace,
    rootDir: checkpointRoot,
    runId,
  });
  const leaseService = new WorkspaceLeaseService();
  let lease;
  let contentionBlocker;
  let activePoint;
  let duringFaultConsumed = false;
  let actualEffectExecutions = 0;
  let checkpointCount = 0;
  const facts = [];

  const engine = new ToolExecutionEngine({
    persist: async (fact) => {
      const point = lifecyclePoint(fact.resolution.phase);
      if (point !== scenario.point) {
        facts.push(fact);
        return;
      }
      journal.event(fact);
      await consumeDuring(point);
      await journal.flush("critical");
      facts.push(fact);
    },
  });

  let observedError;
  try {
    await boundary("call_fact", () =>
      engine.recordCall({ ...identity, tool: `fault-${scenario.effect}` }),
    );
    await boundary("capability", () =>
      engine.advance(identity, {
        phase: "capability_resolved",
        status: "completed",
        result: { recoveryDisposition: "requires_human" },
      }),
    );
    await boundary("policy", () =>
      engine.advance(identity, {
        phase: "policy_resolved",
        status: "completed",
        result: { authorizationState: "allowed" },
      }),
    );
    await boundary("approval", () =>
      engine.advance(identity, {
        phase: "approval_resolved",
        status: "skipped",
        reason: "真实边界探针无需人工审批",
      }),
    );
    await boundary("lease", async () => {
      lease = await leaseService.acquire({
        workspaceRoot: scenarioWorkspace,
        lane: "workspace_exclusive",
        owner: { runId, callId },
      });
      tracker.heldLeases.add(lease);
      await engine.advance(identity, { phase: "lease_acquired", status: "completed" });
    });
    await boundary("checkpoint", async () => {
      const checkpoints = await checkpointManager.captureAll(
        `fault-${scenario.effect}`,
        { path: "checkpoint-target.txt" },
        {
          toolCallId: callId,
          idempotencyKey: `${runId}:fault-step:${callId}`,
          capability: checkpointCapability(scenario.effect),
          pathFields: ["path"],
        },
      );
      checkpointCount = checkpoints.length;
      await consumeDuring("checkpoint");
      for (const checkpoint of checkpoints) {
        await journal.appendFact("checkpoint", checkpoint, { durability: "critical" });
      }
      await engine.advance(identity, {
        phase: "checkpoint_durable",
        status: "completed",
      });
    });
    await boundary("started_barrier", () =>
      engine.advance(identity, {
        phase: "started_durable",
        status: "completed",
        result: { effectState: "started", cleanupState: "pending" },
      }),
    );
    await boundary("adapter", async () => {
      await engine.advance(identity, { phase: "executing", status: "completed" });
      await engine.executeAdapter(identity, async () => {
        actualEffectExecutions += await performActualToolEffect(
          scenario,
          scenarioWorkspace,
          tracker,
        );
        await consumeDuring("adapter");
        return "ok";
      });
    });
    await boundary("effect_terminal", () =>
      engine.advance(identity, {
        phase: "observed",
        status: "completed",
        result: {
          executionOutcome: "returned",
          effectState: scenario.effect === "unknown" ? "unknown" : "committed",
          cleanupState: "pending",
        },
      }),
    );
    await boundary("result_barrier", () =>
      engine.advance(identity, {
        phase: "result_durable",
        status: "completed",
        result: { persistenceState: "durable" },
      }),
    );
    await boundary("cleanup", async () => {
      await lease?.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
      if (lease) tracker.heldLeases.delete(lease);
      lease = undefined;
      await consumeDuring("cleanup");
    });
    await boundary("journal_flush", async () => {
      journal.event({ type: "error", message: "真实 journal flush 边界", fatal: false });
      await consumeDuring("journal_flush");
      await journal.flush("critical");
    });
    await boundary("run_terminal", () =>
      engine.advance(identity, {
        phase: "terminal",
        status: "completed",
        result: { cleanupState: "not_needed" },
      }),
    );
    throw new Error(`真实边界 ${scenario.point}/${scenario.timing} 未触发故障`);
  } catch (error) {
    observedError = error;
  } finally {
    if (lease) {
      await lease
        .release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 })
        .catch(() => lease.rollbackBeforeExecution().catch(() => undefined));
      tracker.heldLeases.delete(lease);
    }
    if (contentionBlocker) {
      await contentionBlocker
        .release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 })
        .catch(() => contentionBlocker.rollbackBeforeExecution().catch(() => undefined));
      tracker.heldLeases.delete(contentionBlocker);
    }
  }

  try {
    // 故障可能发生在 journal.event() 与显式 flush 之间；读取前必须先等待探针自己的 writer 静止。
    await journal.flush("ordinary");
  } catch (error) {
    if (scenario.kind !== "store_failure") {
      throw liveBoundaryFailure(
        `真实边界 ${runId} 的 Journal 未静止：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const expectedCode = faultCode(scenario.kind);
  if (observedError?.code !== expectedCode) {
    const actual = observedError instanceof Error ? observedError.message : String(observedError);
    throw liveBoundaryFailure(
      `真实边界 ${scenario.point}/${scenario.timing}/${scenario.kind} 应产生 ${expectedCode}，实际为 ${actual}`,
    );
  }
  const adapterIndex = POINT_ORDER.indexOf("adapter");
  const pointIndex = POINT_ORDER.indexOf(scenario.point);
  const effectExpected =
    pointIndex > adapterIndex || (scenario.point === "adapter" && scenario.timing !== "before");
  if (actualEffectExecutions !== (effectExpected ? 1 : 0)) {
    throw liveBoundaryFailure(
      `真实 ${scenario.effect} Effect 在 ${scenario.point}/${scenario.timing} 的次数应为 ${effectExpected ? 1 : 0}，实际为 ${actualEffectExecutions}`,
    );
  }
  const checkpointIndex = POINT_ORDER.indexOf("checkpoint");
  const checkpointExpected =
    pointIndex > checkpointIndex ||
    (scenario.point === "checkpoint" && scenario.timing !== "before");
  if (checkpointCount > 0 !== checkpointExpected) {
    throw liveBoundaryFailure(
      `真实 Checkpoint 在 ${scenario.point}/${scenario.timing} 的创建状态不符合预期：${checkpointCount}`,
    );
  }
  if ((await leaseService.inspect(scenarioWorkspace)).state !== "available") {
    throw liveBoundaryFailure(`真实边界探针结束后 Lease 未释放：seed ${scenario.seed}`);
  }
  const unknownEffectObserved =
    scenario.effect === "unknown" &&
    (await pathExists(
      path.join(scenarioWorkspace, `actual-effect-${scenario.seed}`, "unknown.marker"),
    ));
  if (unknownEffectObserved !== (scenario.effect === "unknown" && effectExpected)) {
    throw liveBoundaryFailure(
      `真实 unknown Effect 在 ${scenario.point}/${scenario.timing} 的可观测状态不符合预期`,
    );
  }
  let persistedRecords;
  try {
    persistedRecords = await fileStore.read(runId);
  } catch (error) {
    throw liveBoundaryFailure(
      `真实边界 ${runId} 的持久化记录不可读：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const coverageKey = [scenario.kind, scenario.point, scenario.timing, scenario.effect].join(":");
  tracker.liveBoundaryCoverage.add(coverageKey);
  return {
    status: "passed",
    coverageKey,
    faultCode: expectedCode,
    persistedRecordCount: persistedRecords.length,
    checkpointCount,
    actualEffectExecutions,
    unknownEffectObserved,
  };

  function liveBoundaryFailure(message) {
    return Object.assign(new Error(message), {
      runId,
      callId,
      receiptId: `${runId}:fault-step:${callId}`,
      factPrefix:
        facts.length > 0
          ? facts.slice(0, 6).map((fact) => ({
              phase: fact.resolution.phase,
              status: fact.resolution.status,
            }))
          : [{ point: scenario.point, status: "failed_before_fact" }],
    });
  }

  async function boundary(point, operation) {
    if (point !== scenario.point) return operation();
    if (scenario.timing === "before") await triggerFault();
    activePoint = point;
    try {
      await operation();
    } finally {
      activePoint = undefined;
    }
    if (scenario.timing === "during" && !duringFaultConsumed) {
      throw Object.assign(new Error(`真实边界 ${point} 未消费 during 故障`), {
        code: "fault_boundary_not_exercised",
      });
    }
    if (scenario.timing === "after") await triggerFault();
  }

  async function consumeDuring(point) {
    if (scenario.timing !== "during" || activePoint !== point || duringFaultConsumed) {
      return;
    }
    duringFaultConsumed = true;
    await triggerFault();
  }

  async function triggerFault() {
    switch (scenario.kind) {
      case "sync_throw":
        throw Object.assign(new Error("真实同步故障"), { code: "injected_sync_throw" });
      case "async_reject":
        await Promise.resolve();
        throw Object.assign(new Error("真实异步拒绝"), { code: "injected_async_reject" });
      case "cancel": {
        const controller = new AbortController();
        const error = Object.assign(new Error("真实取消"), { code: "injected_cancel" });
        controller.abort(error);
        throw controller.signal.reason;
      }
      case "timeout":
        await new Promise((resolve) => setTimeout(resolve, 0));
        throw Object.assign(new Error("真实超时"), { code: "injected_timeout" });
      case "late_result": {
        const controller = new AbortController();
        controller.abort(
          Object.assign(new Error("真实迟到结果"), { code: "injected_late_result" }),
        );
        await Promise.resolve("late");
        throw controller.signal.reason;
      }
      case "store_unsupported":
      case "store_failure":
        storeFault = scenario.kind;
        journal.event({ type: "error", message: `真实 ${scenario.kind} 探针`, fatal: false });
        await journal.flush("critical");
        throw new Error(`真实 ${scenario.kind} 未拒绝 critical 写入`);
      case "lease_contention": {
        if (!lease) {
          const blockerService = new WorkspaceLeaseService();
          contentionBlocker = await blockerService.acquire({
            workspaceRoot: scenarioWorkspace,
            lane: "workspace_exclusive",
            owner: { runId: `${runId}-blocker`, callId: `${callId}-blocker` },
          });
          tracker.heldLeases.add(contentionBlocker);
        }
        const contender = new WorkspaceLeaseService();
        const unexpected = await contender.acquire({
          workspaceRoot: scenarioWorkspace,
          lane: "workspace_exclusive",
          owner: { runId: `${runId}-contender`, callId: `${callId}-contender` },
        });
        await unexpected.rollbackBeforeExecution();
        throw new Error("真实 Lease contention 未被拒绝");
      }
    }
  }
}

function lifecyclePoint(phase) {
  return {
    call_recorded: "call_fact",
    capability_resolved: "capability",
    policy_resolved: "policy",
    approval_resolved: "approval",
    lease_acquired: "lease",
    checkpoint_durable: "checkpoint",
    started_durable: "started_barrier",
    observed: "effect_terminal",
    result_durable: "result_barrier",
    terminal: "run_terminal",
  }[phase];
}

function faultCode(kind) {
  return {
    sync_throw: "injected_sync_throw",
    async_reject: "injected_async_reject",
    cancel: "injected_cancel",
    timeout: "injected_timeout",
    late_result: "injected_late_result",
    store_unsupported: "durability_unsupported",
    store_failure: "injected_store_failure",
    lease_contention: "workspace_busy",
  }[kind];
}

function checkpointCapability(effect) {
  return {
    tool: `fault-${effect}`,
    effect,
    replay: effect === "unknown" ? "unknown" : "unsafe",
    concurrency: "workspace_exclusive",
    checkpoint: "required",
    durability: "critical",
    source: "registered",
    resolution: "resolved",
    issues: [],
  };
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
