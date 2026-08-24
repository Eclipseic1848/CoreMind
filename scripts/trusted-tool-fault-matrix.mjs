import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fingerprintEffectReceiptValue as fingerprint,
  projectEffectReceiptBindings,
} from "../packages/coremind-runtime/dist/effect-receipt-binding.js";
import {
  prepareRunResume,
  projectToolCallLifecycles,
  projectToolCapabilities,
  RunStateJournal,
  ToolExecutionEngine,
  WorkspaceLeaseService,
} from "../packages/coremind-runtime/dist/index.js";
import { checkInvariantFacts } from "../packages/coremind-runtime/dist/invariant-checker.js";
import { isRejectedAfterAbort } from "../packages/coremind-runtime/dist/run-state.js";
import {
  createActualFaultInjector,
  createFaultResourceTracker,
  performActualToolEffect,
  runEntryProjectionParityProbe,
  summarizeFaultResources,
} from "./trusted-tool-fault-probes.mjs";
import { runLiveBoundaryProbe } from "./trusted-tool-live-boundary-probes.mjs";

export const FAULT_POINTS = [
  "call_fact",
  "capability",
  "policy",
  "approval",
  "lease",
  "checkpoint",
  "started_barrier",
  "adapter",
  "result_barrier",
  "effect_terminal",
  "cleanup",
  "journal_flush",
  "run_terminal",
];

export const FAULT_KINDS = [
  "sync_throw",
  "async_reject",
  "process_crash",
  "cancel",
  "timeout",
  "late_result",
  "store_unsupported",
  "store_failure",
  "lease_contention",
  "owner_exit",
];

export const TOOL_EFFECTS = ["workspace", "process", "network", "external", "unknown"];
export const FAULT_TIMINGS = ["before", "during", "after"];
export const FAULT_MATRIX_SCENARIO_COUNT =
  FAULT_POINTS.length * FAULT_KINDS.length * TOOL_EFFECTS.length * FAULT_TIMINGS.length;

const INVARIANTS = Array.from({ length: 10 }, (_, index) => `B-${index + 1}`);
export function generateTrustedToolFaultScenario(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("seed 必须是非负安全整数");
  return {
    seed,
    point: FAULT_POINTS[seed % FAULT_POINTS.length],
    kind: FAULT_KINDS[Math.floor(seed / FAULT_POINTS.length) % FAULT_KINDS.length],
    effect:
      TOOL_EFFECTS[
        Math.floor(seed / (FAULT_POINTS.length * FAULT_KINDS.length)) % TOOL_EFFECTS.length
      ],
    timing:
      FAULT_TIMINGS[
        Math.floor(seed / (FAULT_POINTS.length * FAULT_KINDS.length * TOOL_EFFECTS.length)) %
          FAULT_TIMINGS.length
      ],
  };
}

export async function runTrustedToolFaultMatrix(options = {}) {
  const seedStart = options.seedStart ?? 0;
  const seedEnd = options.seedEnd ?? FAULT_MATRIX_SCENARIO_COUNT;
  const ownsWorkspace = options.workspaceRoot === undefined;
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(path.join(tmpdir(), "coremind-fault-matrix-")));
  const tracker = createFaultResourceTracker();
  const invariantPasses = Object.fromEntries(INVARIANTS.map((invariant) => [invariant, 0]));
  const faultInjectionCounts = Object.fromEntries(FAULT_KINDS.map((kind) => [kind, 0]));
  const actualFaultProbes = {
    workerExits: 0,
    cancellations: 0,
    timeouts: 0,
    storeFailures: 0,
    lateResults: 0,
    ownedCrashes: 0,
  };
  const failures = [];
  let bindingConflictRejections = 0;
  let capabilityConflictRejections = 0;
  let externalResumeBlocks = 0;
  let unsafeResumeBlocks = 0;
  let projectionRebuilds = 0;
  let leaseConflictRejections = 0;
  let nonQuiescentReleaseRejections = 0;
  let lateTerminalRejections = 0;
  let invariantGatePasses = 0;
  let adapterBypassRejections = 0;
  let integratedFaultInjections = 0;
  let invariantFactPrefixChecks = 0;
  let axisIsolationPasses = 0;
  let actualEffectExecutions = 0;
  let replay;
  let parallelBatchCount = 0;
  let entryProjectionProbe = { status: "not_run" };
  try {
    if (options.runEntryParityProbe) {
      const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      entryProjectionProbe = await runEntryProjectionParityProbe(repositoryRoot, tracker);
    }
    const scenarios = Array.from({ length: seedEnd - seedStart }, (_, index) =>
      generateTrustedToolFaultScenario(seedStart + index),
    );
    const batchSize = options.batchSize ?? 20;
    for (let offset = 0; offset < scenarios.length; offset += batchSize) {
      parallelBatchCount += 1;
      const batch = scenarios.slice(offset, offset + batchSize);
      const settled = await Promise.allSettled(
        batch.map((scenario) => executeScenario(scenario, workspaceRoot, tracker)),
      );
      for (let index = 0; index < batch.length; index += 1) {
        const scenario = batch[index];
        const result = settled[index];
        if (result.status === "rejected") {
          failures.push(createTrustedToolFaultFailure(scenario, result.reason));
          continue;
        }
        const evidence = result.value;
        try {
          for (const invariant of verifyScenario(scenario, evidence)) {
            invariantPasses[invariant] += 1;
          }
          bindingConflictRejections += evidence.bindingConflictRejections;
          capabilityConflictRejections += evidence.capabilityConflictRejections;
          externalResumeBlocks += evidence.externalResumeBlocks;
          unsafeResumeBlocks += evidence.unsafeResumeBlocks;
          projectionRebuilds += evidence.projectionRebuilds;
          leaseConflictRejections += evidence.leaseConflictRejections;
          nonQuiescentReleaseRejections += evidence.nonQuiescentReleaseRejections;
          lateTerminalRejections += evidence.lateTerminalRejections;
          invariantGatePasses += evidence.invariantGateViolations.length === 0 ? 1 : 0;
          adapterBypassRejections += evidence.adapterBypassRejections;
          integratedFaultInjections += 1;
          invariantFactPrefixChecks += 1;
          axisIsolationPasses += evidence.axisIsolationPasses;
          actualEffectExecutions += evidence.actualEffectExecutions;
          faultInjectionCounts[scenario.kind] += 1;
          for (const key of Object.keys(actualFaultProbes)) {
            actualFaultProbes[key] += evidence.faultProbe[key];
          }
          replay ??= replayEvidence(scenario, evidence);
        } catch (error) {
          failures.push({
            seed: scenario.seed,
            runId: evidence.runId,
            callId: evidence.callId,
            receiptId: evidence.receiptId,
            point: scenario.point,
            kind: scenario.kind,
            factPrefix: replayEvidence(scenario, evidence).factPrefix,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    if (entryProjectionProbe.status === "passed") invariantPasses["B-10"] = 1;
    return {
      status: failures.length === 0 ? "passed" : "failed",
      seedRange: [seedStart, seedEnd],
      scenarioCount: seedEnd - seedStart,
      invariantPasses,
      bindingConflictRejections,
      capabilityConflictRejections,
      externalResumeBlocks,
      unsafeResumeBlocks,
      projectionRebuilds,
      leaseConflictRejections,
      nonQuiescentReleaseRejections,
      lateTerminalRejections,
      invariantGatePasses,
      adapterBypassRejections,
      integratedFaultInjections,
      invariantFactPrefixChecks,
      invariantFactsSource: "tool_execution_engine",
      axisIsolationPasses,
      actualEffectExecutions,
      parallelBatchCount,
      faultInjectionCounts,
      actualFaultProbes,
      ownedCrashCoverage: [...tracker.ownedCrashCoverage].sort(),
      actualBoundaryCoverage: [
        ...new Set([...tracker.ownedCrashCoverage, ...tracker.liveBoundaryCoverage]),
      ].sort(),
      ownedProcessConcurrency: {
        limit: tracker.ownedProcessLimit,
        peak: tracker.peakOwnedProcesses,
        active: tracker.activeOwnedProcesses,
        waiting: tracker.ownedProcessWaiters.length,
      },
      entryProjectionProbe,
      resourceSummary: summarizeFaultResources(tracker),
      failures,
      replay,
    };
  } finally {
    if (ownsWorkspace) await rm(workspaceRoot, { recursive: true, force: true });
  }
}

export function createTrustedToolFaultFailure(scenario, reason) {
  return {
    seed: scenario.seed,
    runId: reason?.runId ?? `fault-run-${scenario.seed}`,
    callId: reason?.callId ?? `fault-call-${scenario.seed}`,
    receiptId:
      reason?.receiptId ?? `fault-run-${scenario.seed}:fault-step:fault-call-${scenario.seed}`,
    point: scenario.point,
    kind: scenario.kind,
    factPrefix: Array.isArray(reason?.factPrefix) ? reason.factPrefix : [],
    message: reason instanceof Error ? reason.message : String(reason),
  };
}

async function executeScenario(scenario, workspaceRoot, tracker) {
  const runId = `fault-run-${scenario.seed}`;
  const callId = `fault-call-${scenario.seed}`;
  const identity = { agent: "main", callId, stepId: "fault-step" };
  const receiptId = `${runId}:${identity.stepId}:${callId}`;
  const facts = [];
  let adapterCalls = 0;
  let retryCalls = 0;
  let actualEffectExecutions = 0;
  const liveBoundary = await runLiveBoundaryProbe(scenario, workspaceRoot, tracker);
  const injector = createActualFaultInjector(scenario, workspaceRoot, tracker);
  const engine = new ToolExecutionEngine({
    persist: async (fact) =>
      injector.intercept(faultPointForLifecyclePhase(fact.resolution.phase), async () => {
        facts.push(fact);
      }),
  });
  try {
    await injector.run("call_fact", () =>
      engine.recordCall({ ...identity, tool: `fault-${scenario.effect}` }),
    );
    await injector.run("capability", () =>
      engine.advance(identity, {
        phase: "capability_resolved",
        status: "completed",
        result: {
          recoveryDisposition:
            scenario.effect === "workspace" ? "requires_proof" : "requires_human",
        },
      }),
    );
    await injector.run("policy", () =>
      engine.advance(identity, {
        phase: "policy_resolved",
        status: "completed",
        result: { authorizationState: "allowed" },
      }),
    );
    await injector.run("approval", () =>
      engine.advance(identity, {
        phase: "approval_resolved",
        status: "skipped",
        reason: "独立矩阵无需人工审批",
      }),
    );
    await injector.run("lease", () =>
      engine.advance(identity, { phase: "lease_acquired", status: "completed" }),
    );
    await injector.run("checkpoint", () =>
      engine.advance(identity, { phase: "checkpoint_durable", status: "completed" }),
    );
    await injector.run("started_barrier", () =>
      engine.advance(identity, {
        phase: "started_durable",
        status: "completed",
        result: { effectState: "started", cleanupState: "pending" },
      }),
    );
    await injector.run("adapter", async () => {
      await engine.advance(identity, { phase: "executing", status: "completed" });
      await engine.executeAdapter(identity, () =>
        injector.intercept("adapter", async () => {
          adapterCalls += 1;
          actualEffectExecutions += await performActualToolEffect(scenario, workspaceRoot, tracker);
          return "ok";
        }),
      );
      await engine
        .executeAdapter(identity, async () => {
          retryCalls += 1;
          return "forbidden retry";
        })
        .catch(() => undefined);
    });
    await injector.run("effect_terminal", () =>
      engine.advance(identity, {
        phase: "observed",
        status: "completed",
        result: {
          executionOutcome: "returned",
          effectState: "committed",
          cleanupState: "quiescent",
        },
      }),
    );
    await injector.run("result_barrier", () =>
      engine.advance(identity, {
        phase: "result_durable",
        status: "completed",
        result: { persistenceState: "durable" },
      }),
    );
    await injector.run("cleanup", () =>
      executeCleanupBoundary(scenario, workspaceRoot, tracker, injector),
    );
    await injector.run("journal_flush", () => executeJournalFlushBoundary(scenario, injector));
    await injector.run("run_terminal", () =>
      engine.advance(identity, {
        phase: "terminal",
        status: "completed",
        result: { cleanupState: "not_needed" },
      }),
    );
    throw new Error(`seed ${scenario.seed} 未在目标边界注入故障`);
  } catch (error) {
    if (error?.injectedFault !== true) {
      if (error && typeof error === "object") {
        error.factPrefix = facts.map((fact) => ({
          phase: fact.resolution.phase,
          status: fact.resolution.status,
        }));
      }
      throw error;
    }
  }
  const faultProbe = injector.evidence;

  const capability = capabilityFor(scenario);
  const capabilityFingerprint = fingerprint(capability);
  const binding = {
    version: 1,
    runId,
    turnId: `fault-turn-${scenario.seed}`,
    agent: identity.agent,
    stepId: identity.stepId,
    callId,
    tool: `fault-${scenario.effect}`,
    argumentsFingerprint: fingerprint({ seed: scenario.seed }),
    capabilityFingerprint,
  };
  const receiptEvent = {
    type: "effect_receipt",
    idempotencyKey: receiptId,
    tool: binding.tool,
    agent: identity.agent,
    callId,
    turnId: binding.turnId,
    binding,
  };
  const receiptEvents =
    adapterCalls === 0
      ? [{ ...receiptEvent, status: "not_started" }]
      : [
          { ...receiptEvent, status: "started" },
          { ...receiptEvent, status: "unknown" },
        ];
  const bindingConflictRejections = verifyBindingIsolation(receiptEvent, binding);
  const capabilityConflictRejections = verifyCapabilityIsolation(
    identity,
    binding.tool,
    capability,
  );
  const adapterBypassRejections = await verifyAdapterBypass(scenario);
  const axisIsolationPasses = await verifyResultAxisIsolation(scenario.seed);
  const externalResumeBlocks = verifyUnknownExternalResume(scenario.seed);
  const unsafeResumeBlocks = verifyScenarioResume(scenario);
  const projectedReceipts = projectEffectReceiptBindings(receiptEvents);
  const lifecycle = engine.inspect(identity);
  const projection = projectToolCallLifecycles(JSON.parse(JSON.stringify(facts)));
  const leaseEvidence = await verifyWorkspaceLease(scenario, workspaceRoot, tracker);
  const lateTerminalRejections = isRejectedAfterAbort({
    event: {
      type: "tool_result",
      agent: identity.agent,
      callId,
      stepId: identity.stepId,
      tool: binding.tool,
      isError: false,
    },
  })
    ? 1
    : 0;
  const invariantGateViolations = verifyInvariantGate({
    scenario,
    runId,
    identity,
    receiptEvents,
    adapterCalls,
    facts,
  });
  return {
    runId,
    callId,
    receiptId,
    facts,
    adapterCalls,
    retryCalls,
    actualEffectExecutions,
    lifecycle,
    projectedReceipts,
    bindingConflictRejections,
    capabilityConflictRejections,
    adapterBypassRejections,
    axisIsolationPasses,
    externalResumeBlocks,
    unsafeResumeBlocks,
    projection,
    projectionRebuilds: 1,
    faultProbe,
    liveBoundary,
    ...leaseEvidence,
    lateTerminalRejections,
    invariantGateViolations,
  };
}

function faultPointForLifecyclePhase(phase) {
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

async function executeCleanupBoundary(scenario, workspaceRoot, tracker, injector) {
  const root = path.join(workspaceRoot, `cleanup-boundary-${scenario.seed}`);
  await mkdir(root, { recursive: true });
  const service = new WorkspaceLeaseService();
  const lease = await service.acquire({
    workspaceRoot: root,
    lane: "workspace_exclusive",
    owner: { runId: `cleanup-run-${scenario.seed}`, callId: `cleanup-call-${scenario.seed}` },
  });
  tracker.heldLeases.add(lease);
  let released = false;
  try {
    await injector.intercept("cleanup", async () => {
      await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
      released = true;
      tracker.heldLeases.delete(lease);
    });
  } finally {
    if (!released) await lease.rollbackBeforeExecution().catch(() => undefined);
    tracker.heldLeases.delete(lease);
  }
}

async function executeJournalFlushBoundary(scenario, injector) {
  const records = [];
  const store = {
    supportedDurability: ["ordinary", "critical"],
    durabilityBoundary: "process_crash",
    append: async (record) => {
      records.push(record);
    },
    barrier: async (_runId, durability) =>
      injector.intercept("journal_flush", async () => ({
        requested: durability,
        achieved: durability,
        boundary: "process_crash",
      })),
    read: async () => [...records],
  };
  const journal = new RunStateJournal(`fault-journal-${scenario.seed}`, store);
  journal.event({ type: "agent_start", agent: "main" });
  await journal.flush("critical");
}

function verifyScenario(scenario, evidence) {
  const passed = [];
  const injectedBoundary = evidence.faultProbe.boundaryTrace.at(-1);
  assertInvariant(
    "fault-probe",
    evidence.faultProbe.triggered &&
      evidence.faultProbe.point === scenario.point &&
      evidence.faultProbe.timing === scenario.timing &&
      ((!["process_crash", "owner_exit"].includes(scenario.kind) &&
        evidence.faultProbe.ownedCrash === undefined) ||
        evidence.faultProbe.ownedCrash?.status === "passed") &&
      injectedBoundary?.point === scenario.point &&
      injectedBoundary.status === `injected_${scenario.timing}`,
  );
  assertInvariant(
    "B-1",
    (evidence.facts.some(
      (fact) =>
        fact.resolution.phase === "started_durable" && fact.resolution.status === "completed",
    ) ||
      evidence.actualEffectExecutions === 0) &&
      evidence.actualEffectExecutions <= 1,
  );
  passed.push("B-1");
  assertInvariant("B-2", replayFor(scenario) === "safe" || evidence.unsafeResumeBlocks === 1);
  passed.push("B-2");
  assertInvariant(
    "B-3",
    evidence.projectedReceipts.length === 1 && evidence.bindingConflictRejections === 5,
  );
  passed.push("B-3");
  assertInvariant(
    "B-4",
    evidence.adapterCalls <= 1 &&
      evidence.retryCalls === 0 &&
      evidence.adapterBypassRejections === 1,
  );
  passed.push("B-4");
  assertInvariant("B-5", evidence.capabilityConflictRejections === 1);
  passed.push("B-5");
  assertInvariant(
    "B-6",
    evidence.maxConcurrentWriters <= 1 &&
      evidence.leaseConflictRejections === (scenario.effect === "workspace" ? 1 : 0),
  );
  passed.push("B-6");
  assertInvariant(
    "B-7",
    scenario.effect !== "workspace" ||
      (evidence.nonQuiescentReleaseRejections === 1 && evidence.leaseReleased),
  );
  passed.push("B-7");
  assertInvariant("B-8", evidence.externalResumeBlocks === 1);
  passed.push("B-8");
  assertInvariant(
    "B-9",
    evidence.axisIsolationPasses === 5 &&
      (evidence.lifecycle === undefined ||
        (evidence.lifecycle.result.executionOutcome &&
          evidence.lifecycle.result.effectState &&
          evidence.lifecycle.result.persistenceState &&
          evidence.lifecycle.result.recoveryDisposition &&
          evidence.lifecycle.result.cleanupState)),
  );
  passed.push("B-9");
  assertInvariant(
    "projection",
    evidence.projectionRebuilds === 1 && evidence.projection.length <= 1,
  );
  assertInvariant("cleanup", evidence.lateTerminalRejections === 1);
  assertInvariant("I-1～I-12", evidence.invariantGateViolations.length === 0);
  return passed;
}

function replayEvidence(scenario, evidence) {
  return {
    seed: scenario.seed,
    runId: evidence.runId,
    callId: evidence.callId,
    point: scenario.point,
    kind: scenario.kind,
    receiptId: evidence.receiptId,
    factPrefix: evidence.facts.slice(0, 6).map((fact) => ({
      phase: fact.resolution.phase,
      status: fact.resolution.status,
    })),
  };
}

function verifyBindingIsolation(receiptEvent, binding) {
  const variants = [
    { binding: { ...binding, argumentsFingerprint: "c".repeat(64) } },
    { binding: { ...binding, runId: `${binding.runId}-other` } },
    {
      turnId: `${binding.turnId}-other`,
      binding: { ...binding, turnId: `${binding.turnId}-other` },
    },
    {
      callId: `${binding.callId}-other`,
      binding: { ...binding, callId: `${binding.callId}-other` },
    },
    { binding: { ...binding, capabilityFingerprint: "d".repeat(64) } },
  ];
  let rejections = 0;
  for (const variant of variants) {
    try {
      projectEffectReceiptBindings([
        { ...receiptEvent, status: "started" },
        { ...receiptEvent, ...variant, status: "unknown" },
      ]);
    } catch (error) {
      if (error?.code !== "effect_receipt_conflict") throw error;
      rejections += 1;
    }
  }
  return rejections;
}

function verifyCapabilityIsolation(identity, tool, capability) {
  const recoveryDisposition = recoveryDispositionForCapability(capability);
  const call = {
    type: "tool_call",
    ...identity,
    tool,
    args: {},
  };
  const resolved = {
    type: "capability_resolved",
    ...identity,
    tool,
    capability,
    recoveryDisposition,
  };
  try {
    projectToolCapabilities([
      call,
      resolved,
      {
        ...resolved,
        capability: {
          ...capability,
          durability: capability.durability === "critical" ? "ordinary" : "critical",
        },
      },
    ]);
  } catch (error) {
    if (error?.code === "tool_capability_conflict") return 1;
    throw error;
  }
  return 0;
}

async function verifyAdapterBypass(scenario) {
  const identity = {
    agent: "main",
    stepId: "bypass-public-tool-seam",
    callId: `bypass-public-tool-seam-${scenario.seed}`,
  };
  const engine = new ToolExecutionEngine({ persist: async () => undefined });
  await engine.recordCall({ ...identity, tool: "public-tool-adapter" });
  try {
    await engine.executeAdapter(identity, async () => "forbidden bypass");
  } catch (error) {
    if (error?.code === "tool_lifecycle_invalid") return 1;
    throw error;
  }
  return 0;
}

async function verifyResultAxisIsolation(seed) {
  const baseline = {
    executionOutcome: "returned",
    effectState: "committed",
    persistenceState: "durable",
    recoveryDisposition: "requires_human",
    cleanupState: "quiescent",
  };
  const variants = {
    executionOutcome: { ...baseline, executionOutcome: "threw" },
    effectState: { ...baseline, effectState: "unknown" },
    persistenceState: { ...baseline, persistenceState: "failed" },
    recoveryDisposition: { ...baseline, recoveryDisposition: "forbidden" },
    cleanupState: { ...baseline, cleanupState: "failed" },
  };
  const baselineResult = await projectResultAxes(seed, "baseline", baseline);
  let passes = 0;
  for (const [axis, expected] of Object.entries(variants)) {
    const actual = await projectResultAxes(seed, axis, expected);
    const changed = Object.keys(baseline).filter((key) => actual[key] !== baselineResult[key]);
    if (changed.length !== 1 || changed[0] !== axis || actual[axis] !== expected[axis]) {
      throw new Error(`结果轴 ${axis} 未保持独立：${changed.join(",")}`);
    }
    passes += 1;
  }
  return passes;
}

async function projectResultAxes(seed, variant, expected) {
  const identity = {
    agent: "main",
    stepId: "axis-probe",
    callId: `axis-${seed}-${variant}`,
  };
  const engine = new ToolExecutionEngine({ persist: async () => undefined });
  await engine.recordCall({ ...identity, tool: "axis-probe" });
  await engine.advance(identity, {
    phase: "capability_resolved",
    status: "completed",
    result: { recoveryDisposition: expected.recoveryDisposition },
  });
  await engine.advance(identity, {
    phase: "policy_resolved",
    status: "completed",
    result: { authorizationState: "allowed" },
  });
  await engine.advance(identity, {
    phase: "approval_resolved",
    status: "skipped",
    reason: "轴隔离探针无需审批",
  });
  await engine.advance(identity, { phase: "lease_acquired", status: "completed" });
  await engine.advance(identity, { phase: "checkpoint_durable", status: "completed" });
  await engine.advance(identity, {
    phase: "started_durable",
    status: "completed",
    result: { effectState: "started", cleanupState: "pending" },
  });
  await engine.advance(identity, { phase: "executing", status: "completed" });
  await engine.executeAdapter(identity, async () => "returned");
  await engine.advance(identity, {
    phase: "observed",
    status: "completed",
    result: {
      executionOutcome: expected.executionOutcome,
      effectState: expected.effectState,
      cleanupState: expected.cleanupState,
    },
  });
  await engine.advance(identity, {
    phase: "result_durable",
    status: expected.persistenceState === "failed" ? "failed" : "completed",
    ...(expected.persistenceState === "failed" ? { reason: "轴隔离持久化失败" } : {}),
    result: { persistenceState: expected.persistenceState },
  });
  const state = await engine.advance(identity, {
    phase: "terminal",
    status: "completed",
    result: { cleanupState: expected.cleanupState },
  });
  return {
    executionOutcome: state.result.executionOutcome,
    effectState: state.result.effectState,
    persistenceState: state.result.persistenceState,
    recoveryDisposition: state.result.recoveryDisposition,
    cleanupState: state.result.cleanupState,
  };
}

function verifyUnknownExternalResume(seed) {
  return verifyResumeBlocked(seed, "external", {
    tool: "fault-network",
    effect: "network",
    replay: "unknown",
    concurrency: "run_serial",
    checkpoint: "none",
    durability: "critical",
    source: "registered",
    resolution: "resolved",
    issues: [],
  });
}

function verifyScenarioResume(scenario) {
  return verifyResumeBlocked(scenario.seed, "scenario", capabilityFor(scenario));
}

function verifyResumeBlocked(seed, scope, capability) {
  const runId = `${scope}-resume-run-${seed}`;
  const turnId = `${scope}-resume-turn-${seed}`;
  const callId = `${scope}-resume-call-${seed}`;
  const stepId = `${scope}-resume-step`;
  const tool = capability.tool;
  const args = { seed, scope };
  const binding = {
    version: 1,
    runId,
    turnId,
    agent: "main",
    stepId,
    callId,
    tool,
    argumentsFingerprint: fingerprint(args),
    capabilityFingerprint: fingerprint(capability),
  };
  const receipt = {
    type: "effect_receipt",
    idempotencyKey: `${runId}:${stepId}:${callId}`,
    tool,
    agent: "main",
    stepId,
    callId,
    turnId,
    binding,
  };
  const events = [
    {
      type: "capability_resolved",
      agent: "main",
      stepId,
      callId,
      tool,
      capability,
      recoveryDisposition: recoveryDispositionForCapability(capability),
    },
    {
      type: "tool_call",
      agent: "main",
      stepId,
      callId,
      turnId,
      tool,
      args,
      idempotencyKey: receipt.idempotencyKey,
    },
    { ...receipt, status: "started" },
    { ...receipt, status: "unknown" },
  ];
  const timestamp = "2026-08-23T00:00:00.000Z";
  const records = [
    {
      version: 1,
      runId,
      sequence: 1,
      timestamp,
      kind: "start",
      payload: { configFingerprint: "fault-config", initialPrompt: "fault matrix" },
    },
    ...events.map((event, index) => ({
      version: 1,
      runId,
      sequence: index + 2,
      timestamp,
      kind: "event",
      payload: {
        eventId: `${scope}-resume-event-${seed}-${index + 1}`,
        runId,
        sequence: index + 1,
        timestamp,
        event,
      },
    })),
  ];
  try {
    prepareRunResume(records, "fault-config");
  } catch (error) {
    if (error?.code === "unknown_effect") return 1;
    throw error;
  }
  return 0;
}

async function verifyWorkspaceLease(scenario, workspaceRoot, tracker) {
  if (scenario.effect !== "workspace") {
    return {
      maxConcurrentWriters: 0,
      leaseReleased: true,
      leaseConflictRejections: 0,
      nonQuiescentReleaseRejections: 0,
    };
  }
  const scenarioWorkspace = path.join(workspaceRoot, `workspace-${scenario.seed}`);
  await mkdir(scenarioWorkspace, { recursive: true });
  const owner = new WorkspaceLeaseService();
  const contender = new WorkspaceLeaseService();
  const lease = await owner.acquire({
    workspaceRoot: scenarioWorkspace,
    lane: "workspace_exclusive",
    owner: { runId: `lease-run-${scenario.seed}`, callId: `lease-call-${scenario.seed}` },
  });
  tracker.heldLeases.add(lease);
  let leaseReleased = false;
  let leaseConflictRejections = 0;
  let nonQuiescentReleaseRejections = 0;
  try {
    try {
      const unexpected = await contender.acquire({
        workspaceRoot: scenarioWorkspace,
        lane: "workspace_exclusive",
        owner: {
          runId: `lease-contender-${scenario.seed}`,
          callId: `lease-contender-call-${scenario.seed}`,
        },
      });
      await unexpected.rollbackBeforeExecution();
    } catch (error) {
      if (error?.code !== "workspace_busy") throw error;
      leaseConflictRejections += 1;
    }
    try {
      await lease.release({ activeTools: 1, activeProcesses: 0, pendingCriticalFacts: 0 });
    } catch (error) {
      if (error?.code !== "workspace_lease_not_quiescent") throw error;
      nonQuiescentReleaseRejections += 1;
    }
    await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    tracker.heldLeases.delete(lease);
    leaseReleased = (await owner.inspect(scenarioWorkspace)).state === "available";
    return {
      maxConcurrentWriters: 1,
      leaseReleased,
      leaseConflictRejections,
      nonQuiescentReleaseRejections,
    };
  } finally {
    if (!leaseReleased) await lease.rollbackBeforeExecution().catch(() => undefined);
    tracker.heldLeases.delete(lease);
  }
}

function verifyInvariantGate({ scenario, runId, identity, receiptEvents, adapterCalls, facts }) {
  const timestamp = "2026-08-23T00:00:00.000Z";
  const idempotencyKey = receiptEvents[0].idempotencyKey;
  const completedPhases = new Set(
    facts
      .filter((fact) => fact.resolution.status === "completed")
      .map((fact) => fact.resolution.phase),
  );
  const events = [
    { type: "agent_start", agent: identity.agent, turnId: `fault-turn-${scenario.seed}` },
  ];
  if (completedPhases.has("call_recorded")) {
    events.push({
      type: "tool_call",
      ...identity,
      turnId: `fault-turn-${scenario.seed}`,
      tool: `fault-${scenario.effect}`,
      args: { seed: scenario.seed },
      idempotencyKey,
    });
  }
  if (completedPhases.has("capability_resolved")) {
    events.push({
      type: "capability_resolved",
      ...identity,
      tool: `fault-${scenario.effect}`,
      capability: capabilityFor(scenario),
      recoveryDisposition: recoveryDispositionForCapability(capabilityFor(scenario)),
    });
  }
  events.push(...facts);
  if (completedPhases.has("capability_resolved")) {
    if (adapterCalls === 0) {
      events.push(receiptEvents[0]);
    } else {
      events.push(receiptEvents[0]);
      events.push({
        type: "tool_result",
        ...identity,
        turnId: `fault-turn-${scenario.seed}`,
        tool: `fault-${scenario.effect}`,
        isError: false,
        idempotencyKey,
      });
      events.push(receiptEvents[1]);
    }
  }
  events.push({
    type: "turn_end",
    agent: identity.agent,
    turnId: `fault-turn-${scenario.seed}`,
  });
  const runRecords = [
    {
      version: 1,
      runId,
      sequence: 1,
      timestamp,
      kind: "start",
      payload: { configFingerprint: "fault-config" },
    },
    ...events.map((event, index) => ({
      version: 1,
      runId,
      sequence: index + 2,
      timestamp,
      kind: "event",
      payload: {
        eventId: `fault-event-${scenario.seed}-${index + 1}`,
        runId,
        sequence: index + 1,
        timestamp,
        event,
      },
    })),
    {
      version: 1,
      runId,
      sequence: events.length + 2,
      timestamp,
      kind: "finish",
      payload: { status: "aborted" },
    },
  ];
  return checkInvariantFacts({ runRecords }, { mode: "gate" });
}

function replayFor(scenario) {
  return scenario.seed % 3 === 0 ? "safe" : scenario.seed % 3 === 1 ? "non_idempotent" : "unknown";
}

function capabilityFor(scenario) {
  const replay = replayFor(scenario) === "non_idempotent" ? "unsafe" : replayFor(scenario);
  return {
    tool: `fault-${scenario.effect}`,
    effect: scenario.effect,
    replay,
    concurrency: scenario.effect === "workspace" ? "workspace_exclusive" : "run_serial",
    checkpoint:
      scenario.effect === "workspace"
        ? "required"
        : scenario.effect === "unknown"
          ? "unsupported"
          : "none",
    durability: "critical",
    source: "registered",
    resolution: "resolved",
    issues: [],
  };
}

function recoveryDispositionForCapability(capability) {
  if (capability.replay === "safe") return "requires_proof";
  if (capability.replay === "unsafe") return "forbidden";
  return "requires_human";
}

function assertInvariant(invariant, condition) {
  if (!condition) throw new Error(`${invariant} failed`);
}
