import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { CheckpointManager } from "../packages/coremind-runtime/dist/checkpoint.js";
import { FileRunStore, RunStateJournal } from "../packages/coremind-runtime/dist/run-state.js";
import { ToolExecutionEngine } from "../packages/coremind-runtime/dist/tool-call-lifecycle.js";
import { WorkspaceLeaseService } from "../packages/coremind-runtime/dist/workspace-lease.js";
import { ProcessRunner } from "../packages/coremind-tools/dist/index.js";

const PERSISTENCE_BOUNDARY_POINTS = new Set([
  "call_fact",
  "capability",
  "policy",
  "approval",
  "checkpoint",
  "started_barrier",
  "effect_terminal",
  "result_barrier",
  "journal_flush",
  "run_terminal",
]);

const payload = isMainThread ? JSON.parse(process.argv[2] ?? "null") : workerData;
if (!payload) throw new Error("缺少崩溃 Owner 参数");

if (isMainThread && payload.kind === "owner_exit") {
  const worker = new Worker(new URL(import.meta.url), { workerData: payload });
  worker.once("error", (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(70);
  });
  worker.once("exit", (code) => process.exit(code));
} else {
  await runOwnedScenario(payload);
}

async function runOwnedScenario(input) {
  await mkdir(input.workspaceRoot, { recursive: true });
  await mkdir(input.stateDirectory, { recursive: true });
  await writeFile(path.join(input.workspaceRoot, "checkpoint-target.txt"), "before", "utf8");
  const leaseService = new WorkspaceLeaseService();
  let lease;
  let activePoint;
  const fileStore = new FileRunStore(input.stateDirectory, {
    beforeBarrier: () => {
      if (
        input.timing === "during" &&
        activePoint === input.point &&
        PERSISTENCE_BOUNDARY_POINTS.has(activePoint)
      ) {
        crash(input);
      }
    },
  });
  const journal = new RunStateJournal(input.runId, fileStore);
  const checkpointManager = new CheckpointManager({
    cwd: input.workspaceRoot,
    rootDir: path.join(input.workspaceRoot, ".coremind", "checkpoints"),
    runId: input.runId,
  });
  const engine = new ToolExecutionEngine({
    persist: async (fact) => {
      journal.event(fact);
      await journal.flush("critical");
    },
  });
  const identity = { agent: "main", stepId: "fault-step", callId: input.callId };

  await lifecycleBoundary(input, "call_fact", () =>
    engine.recordCall({ ...identity, tool: `fault-${input.effect}` }),
  );
  await lifecycleBoundary(input, "capability", () =>
    engine.advance(identity, {
      phase: "capability_resolved",
      status: "completed",
      result: { recoveryDisposition: "requires_human" },
    }),
  );
  await lifecycleBoundary(input, "policy", () =>
    engine.advance(identity, {
      phase: "policy_resolved",
      status: "completed",
      result: { authorizationState: "allowed" },
    }),
  );
  await lifecycleBoundary(input, "approval", () =>
    engine.advance(identity, {
      phase: "approval_resolved",
      status: "skipped",
      reason: "崩溃 Owner 探针无需审批",
    }),
  );

  beforeBoundary(input, "lease");
  activePoint = "lease";
  lease = await leaseService.acquire({
    workspaceRoot: input.workspaceRoot,
    lane: "workspace_exclusive",
    owner: { runId: input.runId, callId: input.callId },
  });
  crashAtDuring(input, "lease");
  await engine.advance(identity, { phase: "lease_acquired", status: "completed" });
  await markTargetBoundary(input, "lease");
  activePoint = undefined;
  afterBoundary(input, "lease");

  beforeBoundary(input, "checkpoint");
  activePoint = "checkpoint";
  const checkpoints = await checkpointManager.captureAll(
    `fault-${input.effect}`,
    { path: "checkpoint-target.txt" },
    {
      toolCallId: input.callId,
      idempotencyKey: `${input.runId}:fault-step:${input.callId}`,
      capability: capabilityFor(input.effect),
      pathFields: ["path"],
    },
  );
  await writeFile(input.checkpointMarker, String(checkpoints.length), "utf8");
  for (const checkpoint of checkpoints) {
    await journal.appendFact("checkpoint", checkpoint, { durability: "critical" });
  }
  await journal.flush("critical");
  await engine.advance(identity, {
    phase: "checkpoint_durable",
    status: checkpoints.length > 0 ? "completed" : "skipped",
    ...(checkpoints.length > 0 ? {} : { reason: "能力不要求 Checkpoint" }),
  });
  await markTargetBoundary(input, "checkpoint");
  activePoint = undefined;
  afterBoundary(input, "checkpoint");

  await lifecycleBoundary(input, "started_barrier", () =>
    engine.advance(identity, {
      phase: "started_durable",
      status: "completed",
      result: { effectState: "started", cleanupState: "pending" },
    }),
  );

  beforeBoundary(input, "adapter");
  activePoint = "adapter";
  await engine.advance(identity, { phase: "executing", status: "completed" });
  await engine.executeAdapter(identity, async () => {
    await performOwnedEffect(input);
    crashAtDuring(input, "adapter");
  });
  await markTargetBoundary(input, "adapter");
  activePoint = undefined;
  afterBoundary(input, "adapter");

  await lifecycleBoundary(input, "effect_terminal", () =>
    engine.advance(identity, {
      phase: "observed",
      status: "completed",
      result: {
        executionOutcome: "returned",
        effectState: input.effect === "unknown" ? "unknown" : "committed",
        cleanupState: "pending",
      },
    }),
  );
  await lifecycleBoundary(input, "result_barrier", () =>
    engine.advance(identity, {
      phase: "result_durable",
      status: "completed",
      result: { persistenceState: "durable" },
    }),
  );

  beforeBoundary(input, "cleanup");
  activePoint = "cleanup";
  await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
  lease = undefined;
  crashAtDuring(input, "cleanup");
  await markTargetBoundary(input, "cleanup");
  activePoint = undefined;
  afterBoundary(input, "cleanup");

  journal.event({ type: "error", message: "crash probe journal boundary", fatal: false });
  beforeBoundary(input, "journal_flush");
  activePoint = "journal_flush";
  await journal.flush("critical");
  await writeFile(input.journalMarker, "critical-durable", "utf8");
  await markTargetBoundary(input, "journal_flush");
  activePoint = undefined;
  afterBoundary(input, "journal_flush");

  await lifecycleBoundary(input, "run_terminal", () =>
    engine.advance(identity, {
      phase: "terminal",
      status: "completed",
      result: { cleanupState: "not_needed" },
    }),
  );
  throw new Error(`目标切点 ${input.point}/${input.timing} 未触发崩溃`);

  async function lifecycleBoundary(scenario, point, operation) {
    beforeBoundary(scenario, point);
    activePoint = point;
    await operation();
    if (scenario.point === point && scenario.timing === "during") {
      throw new Error(`切点 ${point} 未在 FileStore durability barrier 内崩溃`);
    }
    await markTargetBoundary(scenario, point);
    activePoint = undefined;
    afterBoundary(scenario, point);
  }
}

async function performOwnedEffect(input) {
  if (input.effect === "unknown") {
    await writeFile(input.effectMarker, "opaque-unknown-effect", "utf8");
    return;
  }
  if (input.effect === "workspace") {
    await writeFile(input.effectMarker, "workspace-effect", "utf8");
    return;
  }
  if (input.effect === "process") {
    const result = await new ProcessRunner().run({
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'process-effect', 'utf8')",
        input.effectMarker,
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error(`真实 process Effect 退出码为 ${result.exitCode}`);
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("真实网络 Effect 未取得端口");
    const response = await fetch(`http://127.0.0.1:${address.port}/${input.effect}`);
    if (!response.ok) throw new Error(`真实网络 Effect 返回 ${response.status}`);
    await response.text();
    await writeFile(input.effectMarker, `${input.effect}-effect`, "utf8");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve(undefined))),
    );
  }
}

function capabilityFor(effect) {
  return {
    tool: `fault-${effect}`,
    effect,
    replay: effect === "unknown" ? "unknown" : "unsafe",
    concurrency: "workspace_exclusive",
    checkpoint: effect === "workspace" ? "required" : "unsupported",
    durability: "critical",
    source: "registered",
    resolution: "resolved",
    issues: [],
  };
}

function beforeBoundary(input, point) {
  if (input.point === point && input.timing === "before") crash(input);
}

function crashAtDuring(input, point) {
  if (input.point === point && input.timing === "during") crash(input);
}

function afterBoundary(input, point) {
  if (input.point === point && input.timing === "after") crash(input);
}

async function markTargetBoundary(input, point) {
  if (input.point === point) await writeFile(input.boundaryMarker, point, "utf8");
}

function crash(input) {
  process.exit(input.kind === "owner_exit" ? 87 : 86);
}
