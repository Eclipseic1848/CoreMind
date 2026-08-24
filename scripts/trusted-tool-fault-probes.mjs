import { access, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FileRunStore,
  MemoryRunStore,
  RunStateJournal,
  WorkspaceLeaseService,
} from "../packages/coremind-runtime/dist/index.js";
import { ProcessRunner } from "../packages/coremind-tools/dist/index.js";

export function createFaultResourceTracker() {
  return {
    pendingPromises: new Set(),
    liveWorkers: new Set(),
    liveProcesses: new Set(),
    heldLeases: new Set(),
    ownedCrashProofs: new Map(),
    ownedCrashCoverage: new Set(),
    liveBoundaryCoverage: new Set(),
    ownedProcessLimit: 4,
    activeOwnedProcesses: 0,
    peakOwnedProcesses: 0,
    ownedProcessWaiters: [],
  };
}

export function summarizeFaultResources(tracker) {
  return {
    pendingPromises: tracker.pendingPromises.size,
    liveWorkers: tracker.liveWorkers.size,
    liveProcesses: tracker.liveProcesses.size,
    heldLeases: tracker.heldLeases.size,
  };
}

export function createActualFaultInjector(scenario, workspaceRoot, tracker) {
  const evidence = {
    kind: scenario.kind,
    point: scenario.point,
    timing: scenario.timing,
    triggered: false,
    workerExits: 0,
    cancellations: 0,
    timeouts: 0,
    storeFailures: 0,
    lateResults: 0,
    ownedCrashes: 0,
    ownedCrash: undefined,
    mechanismCode: undefined,
    boundaryTrace: [],
  };
  let activeDuringPoint;
  let duringFaultConsumed = false;
  const inject = async () => {
    switch (scenario.kind) {
      case "sync_throw": {
        evidence.triggered = true;
        throw Object.assign(new Error("同步故障注入"), { code: "injected_sync_throw" });
      }
      case "async_reject": {
        evidence.triggered = true;
        await trackPromise(
          tracker,
          Promise.reject(
            Object.assign(new Error("异步拒绝注入"), { code: "injected_async_reject" }),
          ),
        );
        return;
      }
      case "process_crash": {
        const proof = ownedCrashProof(scenario, workspaceRoot, tracker);
        evidence.ownedCrash = await proof.promise;
        evidence.triggered = true;
        evidence.workerExits = proof.executed ? 1 : 0;
        evidence.ownedCrashes = proof.executed ? 1 : 0;
        throw Object.assign(new Error("ToolExecutionEngine Owner 进程崩溃"), {
          code: "injected_process_crash",
        });
      }
      case "owner_exit": {
        const proof = ownedCrashProof(scenario, workspaceRoot, tracker);
        evidence.ownedCrash = await proof.promise;
        evidence.triggered = true;
        evidence.workerExits = proof.executed ? 1 : 0;
        evidence.ownedCrashes = proof.executed ? 1 : 0;
        throw Object.assign(new Error("ToolExecutionEngine Owner Worker 退出"), {
          code: "injected_owner_exit",
        });
      }
      case "cancel": {
        await observeExpectedFault(probeAbort(tracker, false), "injected_cancel", () => {
          evidence.triggered = true;
          evidence.cancellations = 1;
        });
        return;
      }
      case "timeout": {
        await observeExpectedFault(probeAbort(tracker, true), "injected_timeout", () => {
          evidence.triggered = true;
          evidence.timeouts = 1;
        });
        return;
      }
      case "late_result": {
        await observeExpectedFault(probeLateResult(tracker), "injected_late_result", () => {
          evidence.triggered = true;
          evidence.lateResults = 1;
        });
        return;
      }
      case "store_unsupported": {
        await observeExpectedFault(
          probeUnsupportedStore(scenario.seed),
          "durability_unsupported",
          () => {
            evidence.triggered = true;
            evidence.storeFailures = 1;
          },
        );
        return;
      }
      case "store_failure": {
        await observeExpectedFault(
          probeFailingStore(scenario.seed),
          "injected_store_failure",
          () => {
            evidence.triggered = true;
            evidence.storeFailures = 1;
          },
        );
        return;
      }
      case "lease_contention": {
        await observeExpectedFault(
          probeLeaseContention(scenario.seed, workspaceRoot, tracker),
          "workspace_busy",
          () => {
            evidence.triggered = true;
          },
        );
        return;
      }
    }
  };
  return {
    evidence,
    async run(point, operation) {
      if (point !== scenario.point) {
        const result = await operation();
        evidence.boundaryTrace.push({ point, status: "completed" });
        return result;
      }
      try {
        if (scenario.timing === "before") {
          await inject();
        } else if (scenario.timing === "during") {
          activeDuringPoint = point;
          duringFaultConsumed = false;
          try {
            await operation();
          } finally {
            activeDuringPoint = undefined;
          }
          if (!duringFaultConsumed) {
            throw Object.assign(new Error(`边界 ${point} 未让实际操作消费故障`), {
              code: "fault_boundary_not_exercised",
            });
          }
        } else {
          await operation();
          evidence.boundaryTrace.push({ point, status: "completed" });
          await inject();
        }
      } catch (error) {
        if (!evidence.triggered) throw error;
        evidence.boundaryTrace.push({ point, status: `injected_${scenario.timing}` });
        if (error && typeof error === "object") {
          evidence.mechanismCode = error.code;
          error.injectedFault = true;
          error.factPrefix = evidence.boundaryTrace.map((entry) => ({ ...entry }));
        }
        throw error;
      }
      throw new Error(`seed ${scenario.seed} 的目标边界 ${point} 未拒绝`);
    },
    async intercept(point, operation) {
      if (activeDuringPoint !== undefined && activeDuringPoint === point && !duringFaultConsumed) {
        duringFaultConsumed = true;
        await inject();
      }
      return operation();
    },
  };
}

export async function runEntryProjectionParityProbe(repositoryRoot, tracker) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli
    ? [npmCli, "test", "--", "packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx"]
    : ["test", "--", "packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx"];
  const result = await trackProcess(
    tracker,
    new ProcessRunner().run({
      command,
      args,
      cwd: repositoryRoot,
      env: { ...process.env, COREMIND_FAULT_MATRIX_ENTRY_PROBE: "1" },
      timeoutMs: 60_000,
      maxOutputBytes: 2 * 1024 * 1024,
    }),
  );
  if (result.exitCode !== 0) {
    throw new Error(`四入口 Projection probe 失败：${result.stderr.slice(-500)}`);
  }
  return {
    status: "passed",
    entries: ["cli", "tui", "typescript", "python"],
    fixtures: ["success", "tool_error"],
    source: "packages/coremind-cli/src/entry-equivalence.acceptance.test.tsx",
  };
}

export async function runOwnedCrashProbe(scenario, workspaceRoot, tracker) {
  const probeRoot = path.join(workspaceRoot, `owned-crash-${scenario.kind}-${scenario.seed}`);
  const ownerWorkspace = path.join(probeRoot, "workspace");
  const stateDirectory = path.join(probeRoot, "run-state");
  const effectMarker = path.join(probeRoot, "effect.marker");
  const journalMarker = path.join(probeRoot, "journal.marker");
  const checkpointMarker = path.join(probeRoot, "checkpoint.marker");
  const boundaryMarker = path.join(probeRoot, "boundary.marker");
  await mkdir(probeRoot, { recursive: true });
  const payload = {
    seed: scenario.seed,
    point: scenario.point,
    timing: scenario.timing,
    kind: scenario.kind,
    effect: scenario.effect,
    runId: `owned-crash-run-${scenario.seed}`,
    callId: `owned-crash-call-${scenario.seed}`,
    workspaceRoot: ownerWorkspace,
    stateDirectory,
    effectMarker,
    journalMarker,
    checkpointMarker,
    boundaryMarker,
    probeStartupDelayMs: scenario.probeStartupDelayMs,
  };
  const scriptPath = fileURLToPath(new URL("./trusted-tool-crash-owner.mjs", import.meta.url));
  const result = await withOwnedProcessSlot(tracker, () =>
    trackProcess(
      tracker,
      new ProcessRunner().run({
        command: process.execPath,
        args: [scriptPath, JSON.stringify(payload)],
        timeoutMs: OWNED_CRASH_PROBE_TIMEOUT_MS,
        maxOutputBytes: 512 * 1024,
      }),
      scenario.kind === "owner_exit",
    ),
  );
  const expectedExitCode = scenario.kind === "owner_exit" ? 87 : 86;
  if (result.exitCode !== expectedExitCode) {
    throw new Error(
      `崩溃 Owner 退出码应为 ${expectedExitCode}，实际为 ${result.exitCode}：${result.stderr.slice(-500)}`,
    );
  }

  const store = new FileRunStore(stateDirectory);
  const records = await store.read(payload.runId);
  const lifecyclePhases = records
    .filter((record) => record.kind === "event" && record.payload?.type === "tool_lifecycle")
    .map((record) => record.payload.resolution.phase);
  const targetPhase = lifecyclePhaseForFaultPoint(scenario.point);
  if (targetPhase) {
    const expectedPresent =
      scenario.timing === "after" ||
      (scenario.timing === "during" && LIFECYCLE_VISIBLE_BEFORE_DURABILITY.has(scenario.point));
    if (lifecyclePhases.includes(targetPhase) !== expectedPresent) {
      throw new Error(
        `崩溃切点 ${scenario.point}/${scenario.timing} 的持久化前缀不符合预期：${lifecyclePhases.join(",")}`,
      );
    }
  }
  const boundaryAcknowledged = await pathExists(boundaryMarker);
  if (boundaryAcknowledged !== (scenario.timing === "after")) {
    throw new Error(
      `崩溃切点 ${scenario.point}/${scenario.timing} 的 boundary acknowledgement 不符合预期`,
    );
  }
  const effectObserved = await pathExists(effectMarker);
  const adapterIndex = OWNED_CRASH_POINT_ORDER.indexOf("adapter");
  const pointIndex = OWNED_CRASH_POINT_ORDER.indexOf(scenario.point);
  const effectShouldBeObserved =
    pointIndex > adapterIndex || (scenario.point === "adapter" && scenario.timing !== "before");
  if (effectObserved !== effectShouldBeObserved) {
    throw new Error(
      `${scenario.effect} Effect 在 ${scenario.point}/${scenario.timing} 的执行证据不符合预期`,
    );
  }
  const checkpointObserved = await pathExists(checkpointMarker);
  const checkpointIndex = OWNED_CRASH_POINT_ORDER.indexOf("checkpoint");
  const checkpointShouldBeObserved =
    pointIndex > checkpointIndex ||
    (scenario.point === "checkpoint" && scenario.timing !== "before");
  if (checkpointObserved !== checkpointShouldBeObserved) {
    throw new Error(`Checkpoint 在 ${scenario.point}/${scenario.timing} 的实际创建证据不符合预期`);
  }
  const journalDurable = await pathExists(journalMarker);
  if (scenario.point === "journal_flush" && journalDurable !== (scenario.timing === "after")) {
    throw new Error(`Journal 崩溃切点的 durability marker 不符合预期：${scenario.timing}`);
  }

  const leaseService = new WorkspaceLeaseService();
  const inspection = await leaseService.inspect(ownerWorkspace);
  const leaseIndex = OWNED_CRASH_POINT_ORDER.indexOf("lease");
  const cleanupIndex = OWNED_CRASH_POINT_ORDER.indexOf("cleanup");
  const leaseWasAcquired =
    pointIndex > leaseIndex || (scenario.point === "lease" && scenario.timing !== "before");
  const leaseShouldRemain =
    leaseWasAcquired &&
    (pointIndex < cleanupIndex || (scenario.point === "cleanup" && scenario.timing === "before"));
  let takeoverRejected = 0;
  if (leaseShouldRemain) {
    if (inspection.state !== "recovery_required" || !inspection.owner) {
      throw new Error(`Owner 崩溃后应要求显式恢复，实际为 ${inspection.state}`);
    }
    try {
      const unexpected = await leaseService.acquire({
        workspaceRoot: ownerWorkspace,
        lane: "workspace_exclusive",
        owner: { runId: `${payload.runId}-contender`, callId: `${payload.callId}-contender` },
      });
      await unexpected.rollbackBeforeExecution();
      throw new Error("Owner 崩溃后 Lease 被静默接管");
    } catch (error) {
      if (error?.code !== "workspace_lease_recovery_required") throw error;
      takeoverRejected = 1;
    }
    await leaseService.recover(ownerWorkspace, inspection.owner.nonce);
  } else if (inspection.state !== "available") {
    throw new Error(`Cleanup 完成后 Lease 应可用，实际为 ${inspection.state}`);
  }

  return {
    status: "passed",
    owner: scenario.kind === "owner_exit" ? "worker" : "process",
    exitCode: result.exitCode,
    persistedFactCount: lifecyclePhases.length,
    targetPhase: targetPhase ?? scenario.point,
    targetPhasePersisted: targetPhase ? lifecyclePhases.includes(targetPhase) : undefined,
    effectObserved,
    checkpointObserved,
    boundaryAcknowledged,
    journalDurable,
    leaseStateAfterCrash: inspection.state,
    takeoverRejected,
  };
}

function ownedCrashProof(scenario, workspaceRoot, tracker) {
  const proofKey = `${scenario.kind}:${scenario.point}:${scenario.timing}:${scenario.effect}`;
  const existing = tracker.ownedCrashProofs.get(proofKey);
  if (existing) return { promise: existing, executed: false };
  const promise = runOwnedCrashProbe(scenario, workspaceRoot, tracker).then((result) => {
    tracker.ownedCrashCoverage.add(proofKey);
    return result;
  });
  tracker.ownedCrashProofs.set(proofKey, promise);
  return { promise, executed: true };
}

export async function performActualToolEffect(scenario, workspaceRoot, tracker) {
  const effectRoot = path.join(workspaceRoot, `actual-effect-${scenario.seed}`);
  await mkdir(effectRoot, { recursive: true });
  const marker = path.join(effectRoot, `${scenario.effect}.marker`);
  if (scenario.effect === "unknown") {
    await writeFile(marker, "opaque-unknown-effect", "utf8");
    return 1;
  }
  if (scenario.effect === "workspace") {
    await writeFile(marker, "workspace-effect", "utf8");
    return 1;
  }
  if (scenario.effect === "process") {
    const result = await trackProcess(
      tracker,
      new ProcessRunner().run({
        command: process.execPath,
        args: [
          "-e",
          "require('node:fs').writeFileSync(process.argv[1], 'process-effect', 'utf8')",
          marker,
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
      }),
    );
    if (result.exitCode !== 0) throw new Error(`真实 process Effect 退出码为 ${result.exitCode}`);
    return 1;
  }
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
  });
  await trackPromise(
    tracker,
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
  );
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("真实网络 Effect 未取得端口");
    const response = await trackPromise(
      tracker,
      fetch(`http://127.0.0.1:${address.port}/${scenario.effect}`),
    );
    if (!response.ok) throw new Error(`真实网络 Effect 返回 ${response.status}`);
    await response.text();
  } finally {
    await trackPromise(
      tracker,
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve(undefined))),
      ),
    );
  }
  return requests;
}

const OWNED_CRASH_POINT_ORDER = [
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

// 真实崩溃探针包含 Node 子进程与 Worker 冷启动；验收预算独立于产品工具执行超时。
const OWNED_CRASH_PROBE_TIMEOUT_MS = 30_000;

const LIFECYCLE_VISIBLE_BEFORE_DURABILITY = new Set([
  "call_fact",
  "capability",
  "policy",
  "approval",
  "started_barrier",
  "effect_terminal",
  "result_barrier",
  "run_terminal",
]);

function lifecyclePhaseForFaultPoint(point) {
  return {
    call_fact: "call_recorded",
    capability: "capability_resolved",
    policy: "policy_resolved",
    approval: "approval_resolved",
    lease: "lease_acquired",
    checkpoint: "checkpoint_durable",
    started_barrier: "started_durable",
    effect_terminal: "observed",
    result_barrier: "result_durable",
    run_terminal: "terminal",
  }[point];
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function probeAbort(tracker, timeout) {
  const controller = new AbortController();
  const pending = new Promise((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new Error("aborted")),
      { once: true },
    );
  });
  const reason = Object.assign(new Error(timeout ? "timeout" : "cancel"), {
    code: timeout ? "injected_timeout" : "injected_cancel",
  });
  if (timeout) setTimeout(() => controller.abort(reason), 0);
  else controller.abort(reason);
  await trackPromise(tracker, pending);
}

async function probeLateResult(tracker) {
  let resolveSource;
  const source = new Promise((resolve) => {
    resolveSource = resolve;
  });
  const controller = new AbortController();
  controller.abort(
    Object.assign(new Error("cancel before late result"), { code: "injected_late_result" }),
  );
  const guarded = source.then(() => {
    if (controller.signal.aborted) throw controller.signal.reason;
    return "unexpected";
  });
  resolveSource("late");
  await trackPromise(tracker, guarded);
}

async function probeUnsupportedStore(seed) {
  const journal = new RunStateJournal(`fault-store-unsupported-${seed}`, new MemoryRunStore());
  journal.event({ type: "agent_start", agent: "main" });
  try {
    await journal.flush("critical");
  } catch (error) {
    if (error?.code === "durability_unsupported") throw error;
    throw error;
  }
  throw new Error("ordinary Store 错误接受了 critical barrier");
}

async function probeFailingStore(seed) {
  const store = {
    supportedDurability: ["ordinary", "critical"],
    durabilityBoundary: "process_crash",
    append: async () => {
      await Promise.resolve();
      throw Object.assign(new Error("commit failure"), { code: "injected_store_failure" });
    },
    read: async () => [],
  };
  const journal = new RunStateJournal(`fault-store-failure-${seed}`, store);
  journal.event({ type: "agent_start", agent: "main" });
  try {
    await journal.flush("critical");
  } catch (error) {
    if (error?.code === "injected_store_failure") throw error;
    throw error;
  }
  throw new Error("失败 Store 未拒绝 critical commit");
}

async function probeLeaseContention(seed, workspaceRoot, tracker) {
  const root = path.join(workspaceRoot, `fault-kind-lease-${seed}`);
  await mkdir(root, { recursive: true });
  const owner = new WorkspaceLeaseService();
  const contender = new WorkspaceLeaseService();
  const lease = await owner.acquire({
    workspaceRoot: root,
    lane: "workspace_exclusive",
    owner: { runId: `kind-owner-${seed}`, callId: `kind-owner-call-${seed}` },
  });
  tracker.heldLeases.add(lease);
  let contentionError;
  try {
    await contender
      .acquire({
        workspaceRoot: root,
        lane: "workspace_exclusive",
        owner: { runId: `kind-contender-${seed}`, callId: `kind-contender-call-${seed}` },
      })
      .then(async (unexpected) => {
        await unexpected.rollbackBeforeExecution();
        throw new Error("Lease contention 未被拒绝");
      })
      .catch((error) => {
        if (error?.code !== "workspace_busy") throw error;
        contentionError = error;
      });
  } finally {
    await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    tracker.heldLeases.delete(lease);
  }
  if (contentionError) throw contentionError;
  throw new Error("Lease contention 未产生 workspace_busy");
}

async function observeExpectedFault(promise, expectedCode, onObserved) {
  try {
    await promise;
  } catch (error) {
    if (error?.code !== expectedCode) throw error;
    onObserved();
    throw error;
  }
  throw new Error(`故障探针未产生 ${expectedCode}`);
}

function trackPromise(tracker, promise) {
  tracker.pendingPromises.add(promise);
  return promise.finally(() => tracker.pendingPromises.delete(promise));
}

function trackProcess(tracker, promise, worker = false) {
  tracker.liveProcesses.add(promise);
  if (worker) tracker.liveWorkers.add(promise);
  return trackPromise(tracker, promise).finally(() => {
    tracker.liveProcesses.delete(promise);
    tracker.liveWorkers.delete(promise);
  });
}

async function withOwnedProcessSlot(tracker, operation) {
  if (tracker.activeOwnedProcesses >= tracker.ownedProcessLimit) {
    await trackPromise(
      tracker,
      new Promise((resolve) => {
        tracker.ownedProcessWaiters.push(resolve);
      }),
    );
  }
  tracker.activeOwnedProcesses += 1;
  tracker.peakOwnedProcesses = Math.max(tracker.peakOwnedProcesses, tracker.activeOwnedProcesses);
  try {
    return await operation();
  } finally {
    tracker.activeOwnedProcesses -= 1;
    tracker.ownedProcessWaiters.shift()?.();
  }
}
