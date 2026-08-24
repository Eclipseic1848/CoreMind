import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCapabilityConcurrency } from "coremind-config";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { RunStateRecord } from "./run-state.js";
import { toolCapabilityCallKey } from "./tool-capability-identity.js";

export interface WorkspaceLeaseOwnerInput {
  runId: string;
  callId: string;
}

export interface WorkspaceLeaseOwner extends WorkspaceLeaseOwnerInput {
  schemaVersion: 1;
  canonicalRoot: string;
  pid: number;
  nonce: string;
  acquiredAt: string;
}

export interface WorkspaceQuiescence {
  activeTools: number;
  activeProcesses: number;
  pendingCriticalFacts: number;
}

export type WorkspaceLeaseInspection =
  | { state: "available"; canonicalRoot: string }
  | { state: "held"; canonicalRoot: string; owner: WorkspaceLeaseOwner }
  | {
      state: "recovery_required";
      canonicalRoot: string;
      owner?: WorkspaceLeaseOwner;
      reason: string;
    };

export interface WorkspaceLeaseRecoveryDecision {
  state: "recovered";
  canonicalRoot: string;
  previousOwner: WorkspaceLeaseOwner;
  recoveredAt: string;
}

export interface WorkspaceLeaseProjection {
  agent: string;
  callId: string;
  stepId?: string;
  canonicalRoot: string;
  lane: ToolCapabilityConcurrency;
  owner: { runId: string; callId: string; pid: number };
  status: "acquired" | "released" | "recovery_required";
}

export interface WorkspaceLeaseHandle {
  readonly canonicalRoot: string;
  readonly lane: ToolCapabilityConcurrency;
  readonly owner: WorkspaceLeaseOwner;
  readonly requiresWriteLease: boolean;
  release(quiescence: WorkspaceQuiescence): Promise<void>;
  rollbackBeforeExecution(): Promise<void>;
}

export interface WorkspaceLeaseAcquireOptions {
  workspaceRoot: string;
  lane: ToolCapabilityConcurrency;
  owner: WorkspaceLeaseOwnerInput;
}

/** 解析相对路径、symlink/junction 与 Windows 大小写后的 Workspace 身份。 */
export async function canonicalizeWorkspace(workspaceRoot: string): Promise<string> {
  const canonical = path.normalize(await realpath(path.resolve(workspaceRoot)));
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

export function workspaceLeasePath(canonicalRoot: string): string {
  return path.join(canonicalRoot, ".coremind", "leases", "workspace-write.lock");
}

/** 本地文件系统 Workspace 单写者服务；不声称网络文件系统或远程分布式一致性。 */
export class WorkspaceLeaseService {
  private readonly runSerialOwners = new Map<string, WorkspaceLeaseOwner>();

  async acquire(options: WorkspaceLeaseAcquireOptions): Promise<WorkspaceLeaseHandle> {
    const canonicalRoot = await canonicalizeWorkspace(options.workspaceRoot);
    const owner: WorkspaceLeaseOwner = {
      schemaVersion: 1,
      canonicalRoot,
      runId: options.owner.runId,
      callId: options.owner.callId,
      pid: process.pid,
      nonce: randomUUID(),
      acquiredAt: new Date().toISOString(),
    };

    if (options.lane === "parallel") return noOpLease(owner, options.lane);
    if (options.lane === "run_serial") return this.acquireRunSerial(owner);

    const lockPath = workspaceLeasePath(canonicalRoot);
    const existing = await this.inspectCanonical(canonicalRoot);
    if (existing.state === "held") {
      throw new CoreMindError(
        "workspace_busy",
        `Workspace ${canonicalRoot} 已由 Run ${existing.owner.runId} 持有写租约`,
      );
    }
    if (existing.state === "recovery_required") {
      throw new CoreMindError(
        "workspace_lease_recovery_required",
        `Workspace ${canonicalRoot} 存在遗留或损坏租约，必须先完成恢复审计`,
      );
    }
    const leaseDirectory = path.dirname(lockPath);
    const candidatePath = path.join(leaseDirectory, `workspace-write.candidate-${owner.nonce}`);
    await mkdir(leaseDirectory, { recursive: true });
    try {
      await writeFile(candidatePath, JSON.stringify(owner), {
        encoding: "utf8",
        flag: "wx",
        flush: true,
      });
      await link(candidatePath, lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const inspection = await this.inspectCanonical(canonicalRoot);
      if (inspection.state === "held") {
        throw new CoreMindError(
          "workspace_busy",
          `Workspace ${canonicalRoot} 已由 Run ${inspection.owner.runId} 持有写租约`,
        );
      }
      if (inspection.state === "available") {
        throw new CoreMindError(
          "workspace_busy",
          `Workspace ${canonicalRoot} 的竞争租约已释放，请重新提交写请求`,
        );
      }
      throw new CoreMindError(
        "workspace_lease_recovery_required",
        `Workspace ${canonicalRoot} 存在遗留或损坏租约，必须先完成恢复审计`,
      );
    } finally {
      await rm(candidatePath, { force: true }).catch(() => undefined);
    }

    return this.fileLease(owner, lockPath);
  }

  async inspect(workspaceRoot: string): Promise<WorkspaceLeaseInspection> {
    return this.inspectCanonical(await canonicalizeWorkspace(workspaceRoot));
  }

  async recover(
    workspaceRoot: string,
    expectedOwnerNonce: string,
  ): Promise<WorkspaceLeaseRecoveryDecision> {
    const canonicalRoot = await canonicalizeWorkspace(workspaceRoot);
    const inspection = await this.inspectCanonical(canonicalRoot);
    if (
      inspection.state !== "recovery_required" ||
      !inspection.owner ||
      inspection.owner.nonce !== expectedOwnerNonce
    ) {
      throw new CoreMindError(
        "workspace_lease_invalid",
        `Workspace ${canonicalRoot} 的遗留 Owner 与恢复决策不匹配`,
      );
    }
    const lockPath = workspaceLeasePath(canonicalRoot);
    const tombstone = `${lockPath}.recovered-${expectedOwnerNonce}`;
    await rename(lockPath, tombstone);
    await rm(tombstone, { force: true });
    await rm(workspaceLeaseCandidatePath(canonicalRoot, expectedOwnerNonce), { force: true }).catch(
      () => undefined,
    );
    return {
      state: "recovered",
      canonicalRoot,
      previousOwner: inspection.owner,
      recoveredAt: new Date().toISOString(),
    };
  }

  private acquireRunSerial(owner: WorkspaceLeaseOwner): WorkspaceLeaseHandle {
    const existing = this.runSerialOwners.get(owner.runId);
    if (existing) {
      throw new CoreMindError(
        "workspace_busy",
        `Run ${owner.runId} 已有 Call ${existing.callId} 占用 run_serial lane`,
      );
    }
    this.runSerialOwners.set(owner.runId, owner);
    let released = false;
    return {
      canonicalRoot: owner.canonicalRoot,
      lane: "run_serial",
      owner,
      requiresWriteLease: false,
      release: async (quiescence) => {
        assertQuiescent(quiescence);
        if (released || this.runSerialOwners.get(owner.runId)?.nonce !== owner.nonce) {
          throw new CoreMindError(
            "workspace_lease_invalid",
            "run_serial lane Owner 已变化或已释放",
          );
        }
        released = true;
        this.runSerialOwners.delete(owner.runId);
      },
      rollbackBeforeExecution: async () => {
        if (released || this.runSerialOwners.get(owner.runId)?.nonce !== owner.nonce) {
          throw new CoreMindError(
            "workspace_lease_invalid",
            "run_serial lane Owner 已变化或已释放",
          );
        }
        released = true;
        this.runSerialOwners.delete(owner.runId);
      },
    };
  }

  private fileLease(owner: WorkspaceLeaseOwner, lockPath: string): WorkspaceLeaseHandle {
    let released = false;
    return {
      canonicalRoot: owner.canonicalRoot,
      lane: "workspace_exclusive",
      owner,
      requiresWriteLease: true,
      release: async (quiescence) => {
        assertQuiescent(quiescence);
        if (released) {
          throw new CoreMindError("workspace_lease_invalid", "Workspace Lease 已释放");
        }
        const current = await readOwner(lockPath);
        if (current.state !== "valid" || !sameOwner(current.owner, owner)) {
          throw new CoreMindError(
            "workspace_lease_invalid",
            `Workspace ${owner.canonicalRoot} 的 Lease Owner 已变化`,
          );
        }
        const tombstone = `${lockPath}.released-${owner.nonce}`;
        await rename(lockPath, tombstone);
        await rm(tombstone, { force: true });
        released = true;
      },
      rollbackBeforeExecution: async () => {
        if (released) {
          throw new CoreMindError("workspace_lease_invalid", "Workspace Lease 已释放");
        }
        const current = await readOwner(lockPath);
        if (current.state !== "valid" || !sameOwner(current.owner, owner)) {
          throw new CoreMindError(
            "workspace_lease_invalid",
            `Workspace ${owner.canonicalRoot} 的 Lease Owner 已变化`,
          );
        }
        const tombstone = `${lockPath}.rolled-back-${owner.nonce}`;
        await rename(lockPath, tombstone);
        await rm(tombstone, { force: true });
        released = true;
      },
    };
  }

  private async inspectCanonical(canonicalRoot: string): Promise<WorkspaceLeaseInspection> {
    const inspected = await readOwner(workspaceLeasePath(canonicalRoot));
    if (inspected.state === "missing") return { state: "available", canonicalRoot };
    if (inspected.state === "invalid") {
      return {
        state: "recovery_required",
        canonicalRoot,
        reason: "租约文件损坏或版本未知",
      };
    }
    if (inspected.owner.canonicalRoot !== canonicalRoot) {
      return {
        state: "recovery_required",
        canonicalRoot,
        owner: inspected.owner,
        reason: "租约 Owner 的 canonical root 与锁路径不一致",
      };
    }
    if (isProcessAlive(inspected.owner.pid)) {
      return { state: "held", canonicalRoot, owner: inspected.owner };
    }
    return {
      state: "recovery_required",
      canonicalRoot,
      owner: inspected.owner,
      reason: "Owner 进程已退出，Effect 状态需要恢复审计",
    };
  }
}

/** 从规范化 Lease Fact 折叠当前状态；缺失历史 Fact 时不按路径或工具名补写。 */
export function projectWorkspaceLeases(
  events: readonly CoreMindEvent[],
): WorkspaceLeaseProjection[] {
  const projected = new Map<string, WorkspaceLeaseProjection>();
  for (const event of events) {
    if (event.type !== "workspace_lease") continue;
    const callKey = toolCapabilityCallKey(event.agent, event.stepId, event.callId);
    const previous = projected.get(callKey);
    if (
      (event.status === "acquired" && previous !== undefined) ||
      (event.status === "released" &&
        (previous?.status !== "acquired" ||
          previous.owner.runId !== event.owner.runId ||
          previous.owner.callId !== event.owner.callId ||
          previous.owner.pid !== event.owner.pid ||
          previous.canonicalRoot !== event.canonicalRoot ||
          previous.lane !== event.lane))
    ) {
      throw new CoreMindError(
        "workspace_lease_invalid",
        `Call ${event.agent}/${event.stepId ?? "-"}/${event.callId} 的 Workspace Lease Fact 冲突`,
      );
    }
    projected.set(callKey, {
      agent: event.agent,
      callId: event.callId,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      canonicalRoot: event.canonicalRoot,
      lane: event.lane,
      owner: event.owner,
      status: event.status,
    });
  }
  return [...projected.values()];
}

export function projectWorkspaceLeasesFromRecords(
  records: readonly RunStateRecord[],
): WorkspaceLeaseProjection[] {
  return projectWorkspaceLeases(
    records.flatMap((record) => {
      if (
        record.kind !== "event" ||
        record.payload === null ||
        typeof record.payload !== "object"
      ) {
        return [];
      }
      const event = (record.payload as { event?: unknown }).event;
      return event && typeof event === "object" && "type" in event ? [event as CoreMindEvent] : [];
    }),
  );
}

function noOpLease(owner: WorkspaceLeaseOwner, lane: "parallel"): WorkspaceLeaseHandle {
  let released = false;
  return {
    canonicalRoot: owner.canonicalRoot,
    lane,
    owner,
    requiresWriteLease: false,
    release: async (quiescence) => {
      assertQuiescent(quiescence);
      if (released) throw new CoreMindError("workspace_lease_invalid", "并行 lane 已释放");
      released = true;
    },
    rollbackBeforeExecution: async () => {
      if (released) throw new CoreMindError("workspace_lease_invalid", "并行 lane 已释放");
      released = true;
    },
  };
}

function workspaceLeaseCandidatePath(canonicalRoot: string, nonce: string): string {
  return path.join(
    path.dirname(workspaceLeasePath(canonicalRoot)),
    `workspace-write.candidate-${nonce}`,
  );
}

function sameOwner(left: WorkspaceLeaseOwner, right: WorkspaceLeaseOwner): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.canonicalRoot === right.canonicalRoot &&
    left.runId === right.runId &&
    left.callId === right.callId &&
    left.pid === right.pid &&
    left.nonce === right.nonce
  );
}

function assertQuiescent(quiescence: WorkspaceQuiescence): void {
  if (
    quiescence.activeTools !== 0 ||
    quiescence.activeProcesses !== 0 ||
    quiescence.pendingCriticalFacts !== 0
  ) {
    throw new CoreMindError(
      "workspace_lease_not_quiescent",
      `Lease 释放要求静止：tools=${quiescence.activeTools}, processes=${quiescence.activeProcesses}, criticalFacts=${quiescence.pendingCriticalFacts}`,
    );
  }
}

async function readOwner(
  lockPath: string,
): Promise<
  { state: "valid"; owner: WorkspaceLeaseOwner } | { state: "missing" } | { state: "invalid" }
> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as Partial<WorkspaceLeaseOwner>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.canonicalRoot === "string" &&
      typeof parsed.runId === "string" &&
      typeof parsed.callId === "string" &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.nonce === "string" &&
      parsed.nonce.length > 0 &&
      typeof parsed.acquiredAt === "string"
    ) {
      return { state: "valid", owner: parsed as WorkspaceLeaseOwner };
    }
    return { state: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    if (error instanceof SyntaxError) return { state: "invalid" };
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
