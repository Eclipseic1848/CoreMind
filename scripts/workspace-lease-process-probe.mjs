import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalizeWorkspace,
  WorkspaceLeaseService,
} from "../packages/coremind-runtime/dist/index.js";

const scriptPath = fileURLToPath(import.meta.url);

if (process.argv[2] === "--child") {
  const [, , , workspaceRoot, runId, mode] = process.argv;
  const service = new WorkspaceLeaseService();
  process.send?.({ type: "ready" });
  process.on("message", async (message) => {
    if (message?.type === "start") {
      try {
        const lease = await service.acquire({
          workspaceRoot,
          lane: "workspace_exclusive",
          owner: { runId, callId: `${runId}-call` },
        });
        if (mode === "owner-exit") {
          sendAndExit({ type: "acquired", runId, nonce: lease.owner.nonce }, 88);
          return;
        }
        process.send?.({ type: "acquired", runId });
        process.once("message", async (next) => {
          if (next?.type !== "release") return;
          await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
          sendAndExit({ type: "released", runId }, 0);
        });
      } catch (error) {
        sendAndExit(
          { type: "rejected", runId, code: error?.code ?? "unknown" },
          error?.code === "workspace_busy" ? 0 : 1,
        );
      }
    }
  });
} else {
  await runProbe();
}

async function runProbe() {
  const probeRoot = await mkdtemp(path.join(tmpdir(), "coremind-lease-process-"));
  const workspaceRoot = path.join(probeRoot, "workspace");
  const linkedRoot = path.join(probeRoot, "workspace-link");
  await mkdir(workspaceRoot);
  await symlink(workspaceRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const children = [
    spawnContender(workspaceRoot, "parent-run"),
    spawnContender(workspaceRoot, "child-run"),
  ];
  try {
    await Promise.all(children.map(waitForReady));
    for (const child of children) child.send({ type: "start" });
    const results = await Promise.all(children.map(waitForDecision));
    const acquired = results.filter((result) => result.type === "acquired");
    const rejected = results.filter(
      (result) => result.type === "rejected" && result.code === "workspace_busy",
    );
    if (acquired.length !== 1 || rejected.length !== 1) {
      throw new Error(`跨进程租约竞争结果无效：${JSON.stringify(results)}`);
    }
    const winner = children[results.findIndex((result) => result.type === "acquired")];
    winner.send({ type: "release" });
    await waitForMessage(winner, (message) => message.type === "released");
    await Promise.all(children.map(waitForExit));
    const service = new WorkspaceLeaseService();
    const inspection = await service.inspect(workspaceRoot);
    if (inspection.state !== "available") {
      throw new Error(`跨进程租约释放后仍被占用：${JSON.stringify(inspection)}`);
    }
    const relativeRoot = path.relative(process.cwd(), workspaceRoot);
    const canonicalRoots = await Promise.all([
      canonicalizeWorkspace(workspaceRoot),
      canonicalizeWorkspace(relativeRoot),
      canonicalizeWorkspace(linkedRoot),
      ...(process.platform === "win32" ? [canonicalizeWorkspace(workspaceRoot.toUpperCase())] : []),
    ]);
    if (new Set(canonicalRoots).size !== 1) {
      throw new Error(`Workspace 路径归一化结果不一致：${JSON.stringify(canonicalRoots)}`);
    }

    const crashedOwner = spawnContender(workspaceRoot, "crashed-owner", "owner-exit");
    children.push(crashedOwner);
    await waitForReady(crashedOwner);
    const crashedDecisionPromise = waitForDecision(crashedOwner);
    crashedOwner.send({ type: "start" });
    const crashedDecision = await crashedDecisionPromise;
    const crashedExitCode = await waitForExit(crashedOwner);
    if (crashedDecision.type !== "acquired" || crashedExitCode !== 88) {
      throw new Error(
        `Owner exit 探针结果无效：${JSON.stringify({ crashedDecision, crashedExitCode })}`,
      );
    }
    const recoveryInspection = await service.inspect(workspaceRoot);
    if (
      recoveryInspection.state !== "recovery_required" ||
      recoveryInspection.owner?.nonce !== crashedDecision.nonce
    ) {
      throw new Error(`Owner exit 未进入恢复审计：${JSON.stringify(recoveryInspection)}`);
    }
    await service
      .acquire({
        workspaceRoot,
        lane: "workspace_exclusive",
        owner: { runId: "silent-takeover", callId: "silent-takeover-call" },
      })
      .then(async (unexpected) => {
        await unexpected.rollbackBeforeExecution();
        throw new Error("Owner exit 后发生了静默 Lease 转移");
      })
      .catch((error) => {
        if (error?.code !== "workspace_lease_recovery_required") throw error;
      });
    await service.recover(workspaceRoot, crashedDecision.nonce);
    const recoveredInspection = await service.inspect(workspaceRoot);
    if (recoveredInspection.state !== "available") {
      throw new Error(`显式恢复后 Lease 仍不可用：${JSON.stringify(recoveredInspection)}`);
    }
    console.log(
      JSON.stringify({
        status: "passed",
        platform: process.platform,
        contenders: results,
        pathAliases: canonicalRoots.length,
        ownerExitState: recoveryInspection.state,
        finalLeaseState: recoveredInspection.state,
      }),
    );
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await rm(probeRoot, { recursive: true, force: true });
  }
}

function spawnContender(workspaceRoot, runId, mode) {
  return fork(scriptPath, ["--child", workspaceRoot, runId, ...(mode ? [mode] : [])], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

function waitForReady(child) {
  return waitForMessage(child, (message) => message.type === "ready");
}

function waitForDecision(child) {
  return waitForMessage(
    child,
    (message) => message.type === "acquired" || message.type === "rejected",
  );
}

function waitForMessage(child, accept) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error("跨进程租约探针等待超时")), 10_000);
    const onMessage = (message) => {
      if (accept(message)) finish(resolve, message);
    };
    const onError = (error) => finish(reject, error);
    const onExit = (code) => finish(reject, new Error(`租约探针子进程提前退出：${code}`));
    const finish = (settle, value) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      settle(value);
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("exit", resolve);
    child.once("error", reject);
  });
}

function sendAndExit(message, code) {
  if (process.send) {
    process.send(message, () => process.exit(code));
  } else {
    process.exit(code);
  }
}
