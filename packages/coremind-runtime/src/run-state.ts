import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isResolvedToolCapability,
  RECOVERY_DISPOSITIONS,
  recoveryDispositionFor,
} from "coremind-tools";
import { canonicalJson as stableJson } from "./canonical-json.js";
import { validateEffectReceiptBindingsAgainstFacts } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import {
  type FactAppendOptions,
  type FactDurabilityReceipt,
  FactLedger,
  type FactLedgerMetrics,
  type FactLedgerStatus,
  flushFactLedgerWith,
} from "./fact-ledger.js";
import { foldInputReceipts, inputFingerprint } from "./input-receipt.js";
import type { LoopControllerSnapshot, LoopPhase } from "./loop-controller.js";
import {
  type DurableOperationSnapshot,
  type OperationStateRecord,
  restoreDurableOperation,
} from "./operation-state.js";
import type { CompletedWorkflowStep } from "./orchestrator.js";
import { projectToolCallLifecycles, validateToolCallLifecycleFact } from "./tool-call-lifecycle.js";
import { toolCapabilityCallKey } from "./tool-capability-identity.js";
import { projectToolCapabilities } from "./tool-capability-projection.js";
import type { CoreMindTraceEvent } from "./trace.js";

export interface EffectReceipt {
  idempotencyKey: string;
  tool: string;
  status: "not_started" | "started" | "committed" | "unknown";
  stepId?: string;
}

export interface ToolReplayCandidate {
  previousReceiptId: string;
  previousCallId: string;
  attempt: number;
  agent: string;
  tool: string;
  stepId?: string;
  argumentsFingerprint: string;
  capabilityFingerprint: string;
}

export type RunStateKind =
  | "start"
  | "resume"
  | "telemetry_configuration"
  | "telemetry_consent"
  | "control"
  | "delegation"
  | "event"
  | "checkpoint"
  | "loop"
  | "operation"
  | "pause"
  | "finish";

export interface RunStateRecord {
  version: 1;
  runId: string;
  sequence: number;
  eventId?: string;
  timestamp: string;
  kind: RunStateKind;
  payload: unknown;
}

export type RunStoreDurability = "ordinary" | "critical";

export type RunStoreDurabilityBoundary =
  | "process_memory"
  | "process_crash"
  | "system_crash"
  | "power_loss";

export interface RunStoreDurabilityAcknowledgement {
  requested: RunStoreDurability;
  achieved: RunStoreDurability;
  boundary: RunStoreDurabilityBoundary;
}

export interface RunStoreDurabilityMetrics {
  ordinary: { succeeded: number; failed: number };
  critical: { succeeded: number; failed: number };
}

export interface RunStore {
  /** 旧 Adapter 缺省时仅按 ordinary/process_memory 兼容，critical 必须失败关闭。 */
  readonly supportedDurability?: readonly RunStoreDurability[];
  readonly durabilityBoundary?: RunStoreDurabilityBoundary;
  append(record: RunStateRecord): Promise<void>;
  commit?(
    record: RunStateRecord,
    durability: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement>;
  barrier?(
    runId: string,
    requested: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement>;
  read(runId: string): Promise<RunStateRecord[]>;
  pathFor?(runId: string): string;
}

export interface RunResumePlan {
  runId: string;
  initialPrompt?: string;
  nextJournalSequence: number;
  nextTraceSequence: number;
  completedSteps: Map<string, CompletedWorkflowStep>;
  effectReceipts: Map<string, EffectReceipt>;
  toolReplayCandidates: ToolReplayCandidate[];
  previousTrace: CoreMindTraceEvent[];
  loopSnapshot?: LoopControllerSnapshot;
  operationSnapshot?: DurableOperationSnapshot;
  operationRecords: OperationStateRecord[];
}

/** 本地 JSONL RunStore：每条记录只追加，不覆盖既有审计。 */
export interface FileRunStoreOptions {
  /** 仅供故障注入测试：临时文件完成后、原子发布前调用。 */
  beforeCommit?: (context: {
    destination: string;
    temporary: string;
    record?: RunStateRecord;
  }) => void | Promise<void>;
  /** 仅供故障注入测试：critical barrier 同步文件前调用。 */
  beforeBarrier?: (context: {
    destination: string;
    runId: string;
    requested: RunStoreDurability;
    /** 精确 Fact commit 时为当前记录；全局 barrier 时缺省。 */
    record?: RunStateRecord;
  }) => void | Promise<void>;
  lockTimeoutMs?: number;
}

export class FileRunStore implements RunStore {
  readonly supportedDurability = ["ordinary", "critical"] as const;
  readonly durabilityBoundary = "process_crash" as const;

  constructor(
    readonly directory: string,
    private readonly options: FileRunStoreOptions = {},
  ) {}

  pathFor(runId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new CoreMindError("invalid_run_id", `非法 runId：${runId}`);
    }
    return path.join(this.directory, `${runId}.jsonl`);
  }

  async append(record: RunStateRecord): Promise<void> {
    try {
      await this.writeRecord(record, "ordinary");
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "run_state_failed",
        `RunState 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async commit(
    record: RunStateRecord,
    durability: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    assertSupportedDurability(this, durability);
    try {
      await this.writeRecord(record, durability);
      return durabilityAcknowledgement(this, durability);
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      const code = durability === "critical" ? "durability_barrier_failed" : "run_state_failed";
      throw new CoreMindError(
        code,
        `RunState ${record.runId} 的 ${durability} commit 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async barrier(
    runId: string,
    requested: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    assertSupportedDurability(this, requested);
    if (requested === "ordinary") return durabilityAcknowledgement(this, requested);
    const destination = this.pathFor(runId);
    try {
      return await this.withWriterLock(destination, async () => {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(destination, "r+");
          await this.options.beforeBarrier?.({ destination, runId, requested });
          await handle.sync();
          return durabilityAcknowledgement(this, requested);
        } finally {
          await handle?.close().catch(() => undefined);
        }
      });
    } catch (error) {
      throw new CoreMindError(
        "durability_barrier_failed",
        `RunState ${runId} 的 critical barrier 失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    try {
      const destination = this.pathFor(runId);
      return await this.withWriterLock(destination, async () => {
        const parsed = await this.readUnlocked(runId, destination);
        if (parsed.repairedText !== undefined) {
          await this.publishAtomically(destination, parsed.repairedText);
        }
        return parsed.records;
      });
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "run_state_failed",
        `RunState 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readUnlocked(
    runId: string,
    destination: string,
  ): Promise<{ records: RunStateRecord[]; repairedText?: string }> {
    let text: string;
    try {
      text = await readFile(destination, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [] };
      throw error;
    }
    const terminated = text.endsWith("\n");
    const lines = text.split("\n");
    if (terminated) lines.pop();
    const records: RunStateRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        if (!terminated && index === lines.length - 1 && records.length > 0) {
          return {
            records,
            repairedText: `${records.map((item) => JSON.stringify(item)).join("\n")}\n`,
          };
        }
        throw new CoreMindError(
          "run_state_corrupt",
          `RunState ${runId} 已损坏：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const record = validateRecord(parsed, runId);
      if (record.sequence !== records.length + 1) {
        throw new CoreMindError("run_state_corrupt", `RunState ${runId} 的记录顺序不连续`);
      }
      records.push(record);
    }
    return { records };
  }

  private async publishAtomically(
    destination: string,
    text: string,
    record?: RunStateRecord,
    durability: RunStoreDurability = "ordinary",
  ): Promise<void> {
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
      await this.options.beforeCommit?.({ destination, temporary, record });
      if (durability === "critical") {
        let handle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          handle = await open(temporary, "r+");
          await this.options.beforeBarrier?.({
            destination,
            runId: record!.runId,
            requested: durability,
            record,
          });
          await handle.sync();
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
      await renameAtomically(temporary, destination);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async writeRecord(record: RunStateRecord, durability: RunStoreDurability): Promise<void> {
    const destination = this.pathFor(record.runId);
    validateRecord(record, record.runId);
    await this.withWriterLock(destination, async () => {
      const parsed = await this.readUnlocked(record.runId, destination);
      const duplicate = parsed.records.find((item) => item.sequence === record.sequence);
      if (duplicate) {
        if (stableJson(duplicate) === stableJson(record)) {
          if (durability === "critical") {
            let handle: Awaited<ReturnType<typeof open>> | undefined;
            try {
              handle = await open(destination, "r+");
              await this.options.beforeBarrier?.({
                destination,
                runId: record.runId,
                requested: durability,
                record,
              });
              await handle.sync();
            } finally {
              await handle?.close().catch(() => undefined);
            }
          }
          return;
        }
        throw new CoreMindError(
          "run_state_conflict",
          `RunState ${record.runId} 的 sequence ${record.sequence} 已由另一条记录占用`,
        );
      }
      const expectedSequence = (parsed.records.at(-1)?.sequence ?? 0) + 1;
      if (record.sequence !== expectedSequence) {
        throw new CoreMindError(
          "run_state_conflict",
          `RunState ${record.runId} 期望 sequence ${expectedSequence}，实际为 ${record.sequence}`,
        );
      }
      const text = `${parsed.records.map((item) => JSON.stringify(item)).join("\n")}${
        parsed.records.length > 0 ? "\n" : ""
      }${JSON.stringify(record)}\n`;
      await this.publishAtomically(destination, text, record, durability);
    });
  }

  private async withWriterLock<T>(destination: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lockPath = `${destination}.lock`;
    const deadline = Date.now() + (this.options.lockTimeoutMs ?? 2_000);
    const owner = {
      pid: process.pid,
      createdAt: new Date().toISOString(),
      nonce: randomUUID(),
    };
    let acquired = false;
    let transientPermissionError: unknown;
    while (!acquired) {
      try {
        await publishWriterLock(lockPath, owner);
        acquired = true;
      } catch (error) {
        const contention = await classifyWriterLockContention(error, lockPath);
        if (contention === "not_contention") throw error;
        if (contention === "transient_missing") transientPermissionError ??= error;
        if (await this.reclaimStaleWriterLock(lockPath)) continue;
        if (Date.now() >= deadline) {
          if (contention === "transient_missing" && transientPermissionError) {
            throw transientPermissionError;
          }
          throw new CoreMindError(
            "run_state_locked",
            `RunState ${path.basename(destination)} 正由另一 writer 使用`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { force: true });
    }
  }

  private async reclaimStaleWriterLock(lockPath: string): Promise<boolean> {
    const inspected = await inspectWriterLock(lockPath);
    if (inspected.state !== "valid" || isProcessAlive(inspected.owner.pid)) return false;

    const claimPath = `${lockPath}.reclaim-${inspected.owner.nonce}`;
    const tombstonePath = `${claimPath}.tombstone-${randomUUID()}`;
    let claimHandle: Awaited<ReturnType<typeof open>>;
    try {
      claimHandle = await open(claimPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      await claimHandle.writeFile(
        JSON.stringify({ pid: process.pid, ownerNonce: inspected.owner.nonce }),
        "utf8",
      );
      const current = await inspectWriterLock(lockPath);
      if (
        current.state !== "valid" ||
        current.owner.nonce !== inspected.owner.nonce ||
        isProcessAlive(current.owner.pid)
      ) {
        return false;
      }
      // 固定 claim 文件由 wx 原子选出唯一回收者；只移动已复核的旧锁，随后只删 tombstone，
      // 永远不对可能已由新 writer 重建的 lockPath 执行删除。
      await rename(lockPath, tombstonePath);
      return true;
    } finally {
      await claimHandle.close().catch(() => undefined);
      await rm(tombstonePath, { force: true }).catch(() => undefined);
      await rm(claimPath, { force: true }).catch(() => undefined);
    }
  }
}

async function publishWriterLock(
  lockPath: string,
  owner: WriterLockOwner & { createdAt: string },
): Promise<void> {
  const candidatePath = `${lockPath}.candidate-${owner.nonce}`;
  try {
    // 先完整并持久化候选文件，再通过 hard link 原子发布，避免崩溃留下无 owner 的空锁。
    await writeFile(candidatePath, JSON.stringify(owner), {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    await link(candidatePath, lockPath);
  } finally {
    await rm(candidatePath, { force: true }).catch(() => undefined);
  }
}

const ATOMIC_RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160, 320, 640, 1_280] as const;

/** Windows 扫描器可能短暂占用新文件；只重试可恢复的 rename 错误。 */
async function renameAtomically(temporary: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      const delay = ATOMIC_RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTransientRenameError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function classifyWriterLockContention(
  error: unknown,
  lockPath: string,
): Promise<"valid_contention" | "path_contention" | "transient_missing" | "not_contention"> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EEXIST") {
    return (await inspectWriterLock(lockPath)).state === "valid"
      ? "valid_contention"
      : "path_contention";
  }
  if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES")) {
    return "not_contention";
  }
  const inspected = await inspectWriterLock(lockPath);
  if (inspected.state === "valid") return "valid_contention";
  // 锁刚好消失时允许短暂重试，但若截止前从未观察到有效 owner，调用方保留原权限异常。
  return inspected.state === "missing" ? "transient_missing" : "not_contention";
}

interface WriterLockOwner {
  pid: number;
  nonce: string;
}

async function inspectWriterLock(
  lockPath: string,
): Promise<
  { state: "valid"; owner: WriterLockOwner } | { state: "missing" } | { state: "invalid" }
> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
      pid?: unknown;
      nonce?: unknown;
    };
    if (
      typeof owner.pid === "number" &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      typeof owner.nonce === "string" &&
      owner.nonce.length > 0
    ) {
      return { state: "valid", owner: { pid: owner.pid, nonce: owner.nonce } };
    }
    return { state: "invalid" };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "missing" }
      : { state: "invalid" };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class MemoryRunStore implements RunStore {
  readonly supportedDurability = ["ordinary"] as const;
  readonly durabilityBoundary = "process_memory" as const;
  private readonly records = new Map<string, RunStateRecord[]>();

  async append(record: RunStateRecord): Promise<void> {
    validateRecord(record, record.runId);
    const items = this.records.get(record.runId) ?? [];
    const duplicate = items.find((item) => item.sequence === record.sequence);
    if (duplicate) {
      if (stableJson(duplicate) === stableJson(record)) return;
      throw new CoreMindError(
        "run_state_conflict",
        `RunState ${record.runId} 的 sequence ${record.sequence} 已由另一条记录占用`,
      );
    }
    const expectedSequence = (items.at(-1)?.sequence ?? 0) + 1;
    if (record.sequence !== expectedSequence) {
      throw new CoreMindError(
        "run_state_conflict",
        `RunState ${record.runId} 期望 sequence ${expectedSequence}，实际为 ${record.sequence}`,
      );
    }
    items.push(structuredClone(record));
    this.records.set(record.runId, items);
  }

  async commit(
    record: RunStateRecord,
    durability: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    assertSupportedDurability(this, durability);
    await this.append(record);
    return durabilityAcknowledgement(this, durability);
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    return structuredClone(this.records.get(runId) ?? []);
  }

  async barrier(
    _runId: string,
    requested: RunStoreDurability,
  ): Promise<RunStoreDurabilityAcknowledgement> {
    assertSupportedDurability(this, requested);
    return durabilityAcknowledgement(this, requested);
  }
}

/** 把同步事件串行化为 RunStore 的有序异步写入。 */
export class RunStateJournal {
  private readonly ledger: FactLedger;
  private aborted = false;
  private rejectedAfterAbortCount = 0;
  private knownTurnIds?: ReadonlySet<string>;
  private readonly durabilityCounters: RunStoreDurabilityMetrics = {
    ordinary: { succeeded: 0, failed: 0 },
    critical: { succeeded: 0, failed: 0 },
  };

  constructor(
    readonly runId: string,
    readonly store: RunStore,
    initialSequence = 0,
  ) {
    this.ledger = new FactLedger(runId, store, initialSequence);
  }

  /**
   * 取消收敛：设置事件准入分界点（规格 03 §3）。
   * 此后收尾事实（operation/loop/pause/finish）放行；终态类事件被静默拒绝并计数。
   * knownTurnIds：分界前已启动的活动集合（R3 判定：分界前启动的工具 receipt 放行）。
   */
  markAborted(knownTurnIds?: ReadonlySet<string>): void {
    this.aborted = true;
    this.knownTurnIds = knownTurnIds;
  }

  /** 已设置准入分界点（transcript 回退等取消语义依赖此标志） */
  isAborted(): boolean {
    return this.aborted;
  }

  /** 准入拒绝的事件计数（记入 metrics.rejectedAfterAbort） */
  rejectedAfterAbort(): number {
    return this.rejectedAfterAbortCount;
  }

  /**
   * 事件准入（trace 层前置调用，规格 03 §3 / ADR"不入 Trace 或 journal"）：
   * abort 后的迟到终态事实返回 false（计数），调用方不写入 trace/collected/回调。
   */
  admitEvent(event: CoreMindEvent): boolean {
    if (!this.aborted) return true;
    if (isRejectedAfterAbort({ event }, this.knownTurnIds)) {
      this.rejectedAfterAbortCount += 1;
      return false;
    }
    return true;
  }

  async start(payload: unknown): Promise<void> {
    await this.appendFact("start", payload);
  }

  event(payload: unknown): void {
    this.enqueue("event", payload);
  }

  resume(payload: unknown): void {
    this.enqueue("resume", payload);
  }

  checkpoint(payload: unknown): void {
    this.enqueue("checkpoint", payload);
  }

  loop(payload: LoopControllerSnapshot): void {
    this.enqueue("loop", payload);
  }

  operation(payload: OperationStateRecord): void {
    this.enqueue("operation", payload);
  }

  pause(payload: unknown): void {
    this.enqueue("pause", payload);
  }

  finish(payload: unknown): void {
    this.enqueue("finish", payload);
  }

  async flush(
    durability: RunStoreDurability = "ordinary",
  ): Promise<RunStoreDurabilityAcknowledgement> {
    try {
      const acknowledgement = await flushFactLedgerWith(this.ledger, async () => {
        assertSupportedDurability(this.store, durability);
        return this.store.barrier
          ? this.store.barrier(this.runId, durability)
          : legacyDurabilityAcknowledgement(this.store, durability);
      });
      validateDurabilityAcknowledgement(this.store, durability, acknowledgement);
      this.durabilityCounters[durability].succeeded += 1;
      return acknowledgement;
    } catch (error) {
      this.durabilityCounters[durability].failed += 1;
      throw error;
    }
  }

  durabilityMetrics(): RunStoreDurabilityMetrics {
    return structuredClone(this.durabilityCounters);
  }

  appendFact(
    kind: RunStateKind,
    payload: unknown,
    options: FactAppendOptions = {},
  ): Promise<FactDurabilityReceipt> {
    return this.ledger.append(kind, payload, options);
  }

  factMetrics(): FactLedgerMetrics {
    return this.ledger.metrics();
  }

  factStatus(): FactLedgerStatus {
    return this.ledger.status();
  }

  pendingFactCount(): number {
    return this.ledger.metrics().pending;
  }

  private enqueue(kind: RunStateKind, payload: unknown): void {
    // 事件准入（规格 03 §3）：分界点后的终态类事件拒绝写入，静默不抛错
    if (this.aborted && kind === "event" && isRejectedAfterAbort(payload, this.knownTurnIds)) {
      this.rejectedAfterAbortCount += 1;
      return;
    }
    void this.appendFact(kind, payload);
  }
}

function assertSupportedDurability(store: RunStore, requested: RunStoreDurability): void {
  const supported = store.supportedDurability ?? ["ordinary"];
  if (supported.includes(requested)) return;
  throw new CoreMindError(
    "durability_unsupported",
    `RunStore 仅支持 ${supported.join(", ")}，不能满足 ${requested}`,
  );
}

function durabilityAcknowledgement(
  store: RunStore,
  requested: RunStoreDurability,
): RunStoreDurabilityAcknowledgement {
  return {
    requested,
    achieved: requested,
    boundary: store.durabilityBoundary ?? "process_memory",
  };
}

function legacyDurabilityAcknowledgement(
  store: RunStore,
  requested: RunStoreDurability,
): RunStoreDurabilityAcknowledgement {
  assertSupportedDurability(store, requested);
  if (requested === "critical") {
    throw new CoreMindError(
      "durability_unsupported",
      "旧 RunStore 未实现 critical barrier acknowledgement",
    );
  }
  return durabilityAcknowledgement(store, requested);
}

function validateDurabilityAcknowledgement(
  store: RunStore,
  requested: RunStoreDurability,
  acknowledgement: RunStoreDurabilityAcknowledgement,
): void {
  const supported = store.supportedDurability ?? ["ordinary"];
  const boundary = store.durabilityBoundary ?? "process_memory";
  const achievedSatisfiesRequest =
    acknowledgement.achieved === "critical" || requested === "ordinary";
  if (
    acknowledgement.requested === requested &&
    achievedSatisfiesRequest &&
    supported.includes(acknowledgement.achieved) &&
    acknowledgement.boundary === boundary &&
    !(requested === "critical" && boundary === "process_memory")
  ) {
    return;
  }
  throw new CoreMindError(
    "durability_barrier_failed",
    `RunStore 返回了与 ${requested}/${boundary} 不一致的 durability acknowledgement`,
  );
}

/** journal 是否仍有未落盘的写入（规格 03 §5：静止条件之一） */
export function hasPendingJournalFlush(journal: RunStateJournal): boolean {
  return journal.pendingFactCount() > 0;
}

/**
 * 准入判定：分界点后到达的终态类事件（规格 03 §3）。
 * - tool_result / turn_end（assistant 文本落定）→ 拒绝（旧活动的迟到终态事实）；
 * - effect_receipt 终态：turnId 属于分界前已启动的活动（R3，knownTurnIds 命中）→ 放行；
 *   否则（无归属或 abort 后新生成的活动）→ 拒绝；
 * - 非终态事件（text_delta / approval_required / error 等）→ 放行。
 */
export function isRejectedAfterAbort(
  payload: unknown,
  knownTurnIds?: ReadonlySet<string>,
): boolean {
  const trace = payload as { event?: Record<string, unknown> };
  const event = trace?.event;
  if (event === null || typeof event !== "object") return false;
  const type = (event as { type?: unknown }).type;
  if (type === "tool_result" || type === "turn_end") return true;
  if (type === "effect_receipt") {
    const receipt = event as { status?: unknown; turnId?: unknown };
    if (receipt.status === undefined || receipt.status === "not_started") return false;
    const turnId = receipt.turnId;
    return turnId === undefined || !knownTurnIds?.has(String(turnId));
  }
  return false;
}

/** 未到达稳定边界的非 replay-safe 工具调用（resumable 安全门的判定结果） */
export interface UnsafeToolCall {
  tool: string;
  stepId?: string;
  idempotencyKey?: string;
  receiptStatus?: EffectReceipt["status"];
}

/**
 * resumable 安全门单点实现（缺口 G-1）：
 * 找出第一个副作用状态无法证明为 not_started 的非 replay-safe 工具调用。
 * 快照 resumable 标志与恢复计划共用此判定，避免双实现漂移。
 */
export function findUnsafeToolCall(
  trace: readonly CoreMindTraceEvent[],
): UnsafeToolCall | undefined {
  const replayCandidateKeys = new Set(
    collectToolReplayCandidates(trace).map((candidate) =>
      toolCapabilityCallKey(candidate.agent, candidate.stepId, candidate.previousCallId),
    ),
  );
  const completedSteps = new Set(
    trace
      .map((entry) => entry.event)
      .filter((event) => event.type === "step_output")
      .map((event) => event.stepId),
  );
  const lifecycleFacts = trace
    .map((entry) => entry.event)
    .filter((event) => event.type === "tool_lifecycle");
  const lifecycleStates = projectToolCallLifecycles(lifecycleFacts);
  const receiptByIdempotencyKey = new Map<string, EffectReceipt>();
  const receiptByLifecycleCall = new Map<string, EffectReceipt>();
  for (const entry of trace) {
    const event = entry.event;
    if (event.type === "effect_receipt") {
      receiptByIdempotencyKey.set(event.idempotencyKey, event);
    }
  }
  for (const entry of trace) {
    const event = entry.event;
    if (event.type !== "tool_call" || !event.callId || !event.idempotencyKey) continue;
    const receipt = receiptByIdempotencyKey.get(event.idempotencyKey);
    if (receipt) {
      receiptByLifecycleCall.set(
        toolCapabilityCallKey(event.agent, event.stepId, event.callId),
        receipt,
      );
    }
  }
  const lifecycleCallKeys = new Set(
    lifecycleStates.map((state) => toolCapabilityCallKey(state.agent, state.stepId, state.callId)),
  );
  if (lifecycleFacts.length > 0) {
    for (const state of lifecycleStates) {
      if (state.stepId && completedSteps.has(state.stepId)) continue;
      const receipt = receiptByLifecycleCall.get(
        toolCapabilityCallKey(state.agent, state.stepId, state.callId),
      );
      const effectState =
        state.result.effectState === "not_started" && receipt?.status === "started"
          ? "unknown"
          : state.result.effectState === "not_started" &&
              (receipt?.status === "committed" || receipt?.status === "unknown")
            ? receipt.status
            : state.result.effectState;
      if (effectState === "not_started") continue;
      if (state.result.recoveryDisposition === "replay_safe") continue;
      if (replayCandidateKeys.has(toolCapabilityCallKey(state.agent, state.stepId, state.callId))) {
        continue;
      }
      return {
        tool: state.tool,
        ...(state.stepId ? { stepId: state.stepId } : {}),
        ...(receipt?.idempotencyKey ? { idempotencyKey: receipt.idempotencyKey } : {}),
        receiptStatus: effectState,
      };
    }
  }

  const receipts = new Map<string, EffectReceipt>();
  const capabilities = new Map(
    projectToolCapabilities(trace.map((entry) => entry.event))
      .filter((projection) => projection.callId !== undefined)
      .map((projection) => [
        toolCapabilityCallKey(projection.agent, projection.stepId, projection.callId!),
        projection,
      ]),
  );
  for (const entry of trace) {
    const event = entry.event;
    if (event.type === "effect_receipt") receipts.set(event.idempotencyKey, event);
    if (event.type === "step_output") completedSteps.add(event.stepId);
  }
  for (const entry of trace) {
    const event = entry.event;
    if (event.type !== "tool_call") continue;
    if (
      event.callId &&
      lifecycleCallKeys.has(toolCapabilityCallKey(event.agent, event.stepId, event.callId))
    ) {
      continue;
    }
    if (event.stepId && completedSteps.has(event.stepId)) continue;
    const receipt = event.idempotencyKey ? receipts.get(event.idempotencyKey) : undefined;
    if (receipt?.status === "not_started") continue;
    const capability = event.callId
      ? capabilities.get(toolCapabilityCallKey(event.agent, event.stepId, event.callId))
      : undefined;
    if (capability?.recoveryDisposition === "replay_safe") continue;
    if (
      event.callId &&
      replayCandidateKeys.has(toolCapabilityCallKey(event.agent, event.stepId, event.callId))
    ) {
      continue;
    }
    return {
      tool: event.tool,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      ...(receipt ? { receiptStatus: receipt.status } : {}),
    };
  }
  return undefined;
}

export function collectToolReplayCandidates(
  trace: readonly CoreMindTraceEvent[],
): ToolReplayCandidate[] {
  const events = trace.map((entry) => entry.event);
  const completedSteps = new Set(
    events.filter((event) => event.type === "step_output").map((event) => event.stepId),
  );
  const bindings = events.some(
    (event) => event.type === "effect_receipt" && event.binding !== undefined,
  )
    ? validateEffectReceiptBindingsAgainstFacts(trace[0]?.runId ?? "", events)
    : [];
  const bindingByReceipt = new Map(bindings.map((binding) => [binding.idempotencyKey, binding]));
  const capabilityByCall = new Map(
    projectToolCapabilities(events)
      .filter((projection) => projection.callId !== undefined)
      .map((projection) => [
        toolCapabilityCallKey(projection.agent, projection.stepId, projection.callId!),
        projection,
      ]),
  );
  const priorAttemptByCall = new Map(
    events.flatMap((event) =>
      event.type === "tool_attempt"
        ? [[toolCapabilityCallKey(event.agent, event.stepId, event.callId), event.attempt] as const]
        : [],
    ),
  );
  const candidates: ToolReplayCandidate[] = [];
  for (const event of events) {
    if (
      event.type !== "tool_call" ||
      !event.callId ||
      !event.idempotencyKey ||
      (event.stepId && completedSteps.has(event.stepId))
    ) {
      continue;
    }
    const callKey = toolCapabilityCallKey(event.agent, event.stepId, event.callId);
    const capability = capabilityByCall.get(callKey);
    const receipt = bindingByReceipt.get(event.idempotencyKey);
    if (
      capability?.capability.replay !== "idempotent" ||
      capability.recoveryDisposition !== "requires_proof" ||
      receipt?.provenance !== "bound" ||
      !receipt.binding ||
      (receipt.status !== "started" && receipt.status !== "unknown")
    ) {
      continue;
    }
    candidates.push({
      previousReceiptId: event.idempotencyKey,
      previousCallId: event.callId,
      attempt: (priorAttemptByCall.get(callKey) ?? 1) + 1,
      agent: event.agent,
      tool: event.tool,
      ...(event.stepId ? { stepId: event.stepId } : {}),
      argumentsFingerprint: receipt.binding.argumentsFingerprint,
      capabilityFingerprint: receipt.binding.capabilityFingerprint,
    });
  }
  return candidates;
}

/** 由 Runtime 单点判断持久化运行是否满足自动恢复的安全前提。 */
export function isRunStateResumable(records: readonly RunStateRecord[]): boolean {
  if (records.length === 0 || records.some((record) => record.kind === "finish")) return false;
  const trace = records
    .filter((record) => record.kind === "event")
    .map((record) => tracePayload(record.payload, record.runId));
  return inputReceiptsAreResumable(trace) && findUnsafeToolCall(trace) === undefined;
}

/** 从中断的 append-only RunState 构造安全恢复计划。 */
export function prepareRunResume(
  records: RunStateRecord[],
  configFingerprint: string,
  requestedPrompt?: string,
): RunResumePlan {
  if (records.length === 0) throw new CoreMindError("unknown_run", "没有可恢复的 RunState");
  const ordered = [...records];
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index]?.sequence !== index + 1) {
      throw new CoreMindError("run_state_corrupt", "RunState sequence 不连续，无法安全恢复");
    }
  }
  if (ordered.some((record) => record.kind === "finish")) {
    throw new CoreMindError("run_already_finished", "已结束的运行不能自动恢复");
  }

  const start = ordered.find((record) => record.kind === "start");
  if (!start || start.payload === null || typeof start.payload !== "object") {
    throw new CoreMindError("run_state_corrupt", "RunState 缺少有效 start 记录");
  }
  const startPayload = start.payload as {
    configFingerprint?: unknown;
    initialPrompt?: unknown;
  };
  if (startPayload.configFingerprint !== configFingerprint) {
    throw new CoreMindError("resume_config_mismatch", "当前配置与中断运行不一致，已拒绝恢复");
  }
  const storedPrompt =
    typeof startPayload.initialPrompt === "string" ? startPayload.initialPrompt : undefined;
  if (requestedPrompt !== undefined) {
    // 输入收据联动（规格 03 §4/§6 R9）：原 run 已登记 input_receipt 时按指纹校验
    // （Trace 只存摘要不落原文）；无收据（0.3.0 旧格式）保留现状字符串比对，语义不变
    const receiptFingerprint = findInputReceiptFingerprint(records);
    const mismatch =
      receiptFingerprint !== undefined
        ? inputFingerprint(requestedPrompt) !== receiptFingerprint
        : requestedPrompt !== storedPrompt;
    if (mismatch) {
      throw new CoreMindError("resume_input_mismatch", "恢复输入与原运行不一致，已拒绝恢复");
    }
  }

  const completedSteps = new Map<string, CompletedWorkflowStep>();
  const effectReceipts = new Map<string, EffectReceipt>();
  const previousTrace: CoreMindTraceEvent[] = [];
  let loopSnapshot: LoopControllerSnapshot | undefined;
  const operationRecords: OperationStateRecord[] = [];
  let nextTraceSequence = 0;
  for (const record of ordered) {
    if (record.kind === "loop") {
      loopSnapshot = loopSnapshotPayload(record.payload, record.runId, configFingerprint);
    }
    if (record.kind === "operation") {
      operationRecords.push(operationRecordPayload(record.payload, record.runId));
    }
    if (record.kind !== "event") continue;
    const trace = tracePayload(record.payload, record.runId);
    previousTrace.push(trace);
    nextTraceSequence = Math.max(nextTraceSequence, trace.sequence);
    const event = trace.event;
    if (event.type === "step_output") {
      const outputEvent = event as {
        type: "step_output";
        stepId: string;
        agent: string;
        text: string;
        saveAs?: string;
      };
      completedSteps.set(outputEvent.stepId, {
        ...(outputEvent.saveAs ? { saveAs: outputEvent.saveAs } : {}),
        output: {
          text: outputEvent.text,
          metadata: { agent: outputEvent.agent, stepId: outputEvent.stepId },
        },
      });
    }
    // tool_call 的安全门判定统一走 findUnsafeToolCall（见下方），这里不再重复收集。
    if (event.type === "effect_receipt") {
      const receipt = event as EffectReceipt & { type: "effect_receipt" };
      effectReceipts.set(receipt.idempotencyKey, {
        idempotencyKey: receipt.idempotencyKey,
        tool: receipt.tool,
        status: receipt.status,
        ...(receipt.stepId ? { stepId: receipt.stepId } : {}),
      });
    }
  }

  const operationSnapshot = operationSnapshotFromRecords(ordered);

  if (!inputReceiptsAreResumable(previousTrace)) {
    throw new CoreMindError("run_already_finished", "输入已到终态，不能自动恢复");
  }
  const unsafe = findUnsafeToolCall(previousTrace);
  if (unsafe) {
    if (unsafe.receiptStatus === "committed") {
      throw new CoreMindError(
        "committed_effect_pending",
        `工具 ${unsafe.tool} 的副作用已提交，但步骤尚未到达稳定边界；为避免重复执行，已暂停自动恢复`,
      );
    }
    throw new CoreMindError(
      "unknown_effect",
      `未完成步骤的工具 ${unsafe.tool} 副作用状态未知；请先人工核对后再决定`,
    );
  }

  return {
    runId: ordered[0]!.runId,
    ...(storedPrompt !== undefined ? { initialPrompt: storedPrompt } : {}),
    nextJournalSequence: ordered.at(-1)!.sequence,
    nextTraceSequence,
    completedSteps,
    effectReceipts,
    toolReplayCandidates: collectToolReplayCandidates(previousTrace),
    previousTrace,
    operationRecords,
    ...(loopSnapshot ? { loopSnapshot } : {}),
    ...(operationSnapshot ? { operationSnapshot } : {}),
  };
}

function inputReceiptsAreResumable(trace: readonly CoreMindTraceEvent[]): boolean {
  try {
    const statuses = foldInputReceipts(trace.map((entry) => entry.event));
    return [...statuses.values()].every((status) => status === "pending" || status === "claimed");
  } catch (error) {
    throw new CoreMindError(
      "run_state_corrupt",
      `输入收据无法安全折叠：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 从 RunState 中校验并提取最新 operation 快照，供 CLI/SDK/Worker 共用。 */
export function operationSnapshotFromRecords(
  records: readonly RunStateRecord[],
): DurableOperationSnapshot | undefined {
  const operationRecords = records
    .filter((record) => record.kind === "operation")
    .map((record) => operationRecordPayload(record.payload, record.runId));
  return operationRecords.length > 0
    ? restoreDurableOperation(operationRecords).snapshot()
    : undefined;
}

/** 配置指纹只落 hash，不把配置或凭据复制进 RunState。 */
export function fingerprintRunConfig(config: unknown): string {
  const resumeConfig =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? Object.fromEntries(
          Object.entries(config as Record<string, unknown>).filter(([key]) => key !== "telemetry"),
        )
      : config;
  return createHash("sha256").update(stableJson(resumeConfig)).digest("hex");
}

function tracePayload(payload: unknown, expectedRunId: string): CoreMindTraceEvent {
  if (payload === null || typeof payload !== "object") {
    throw new CoreMindError("run_state_corrupt", "RunState event 缺少 Trace 对象");
  }
  const trace = payload as {
    eventId?: unknown;
    runId?: unknown;
    sequence?: unknown;
    timestamp?: unknown;
    event?: unknown;
  };
  if (
    typeof trace.eventId !== "string" ||
    trace.runId !== expectedRunId ||
    !Number.isInteger(trace.sequence) ||
    typeof trace.timestamp !== "string" ||
    Number.isNaN(Date.parse(trace.timestamp)) ||
    trace.event === null ||
    typeof trace.event !== "object"
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState event 包含非法 Trace");
  }
  const event = trace.event as Record<string, unknown>;
  if (typeof event.type !== "string") {
    throw new CoreMindError("run_state_corrupt", "RunState Trace 缺少事件类型");
  }
  if (
    event.type === "step_output" &&
    (typeof event.stepId !== "string" ||
      typeof event.agent !== "string" ||
      typeof event.text !== "string" ||
      (event.saveAs !== undefined && typeof event.saveAs !== "string"))
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 step_output");
  }
  if (
    event.type === "tool_call" &&
    (typeof event.tool !== "string" ||
      (event.stepId !== undefined && typeof event.stepId !== "string") ||
      (event.idempotencyKey !== undefined && typeof event.idempotencyKey !== "string"))
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 tool_call");
  }
  if (
    event.type === "effect_receipt" &&
    (typeof event.idempotencyKey !== "string" ||
      typeof event.tool !== "string" ||
      !["not_started", "started", "committed", "unknown"].includes(String(event.status)) ||
      (event.stepId !== undefined && typeof event.stepId !== "string"))
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 effect_receipt");
  }
  if (
    event.type === "capability_resolved" &&
    (typeof event.agent !== "string" ||
      typeof event.tool !== "string" ||
      typeof event.callId !== "string" ||
      (event.stepId !== undefined && typeof event.stepId !== "string") ||
      !isResolvedToolCapability(event.capability, event.tool) ||
      !RECOVERY_DISPOSITIONS.includes(event.recoveryDisposition as never) ||
      recoveryDispositionFor(event.capability) !== event.recoveryDisposition)
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 capability_resolved");
  }
  if (event.type === "tool_lifecycle") {
    try {
      validateToolCallLifecycleFact(event);
    } catch {
      throw new CoreMindError("run_state_corrupt", "RunState 包含非法 tool_lifecycle");
    }
  }
  return trace as CoreMindTraceEvent;
}

const LOOP_PHASES = new Set<LoopPhase>([
  "idle",
  "planning",
  "executing",
  "verifying",
  "repairing",
  "paused",
  "succeeded",
  "failed",
  "aborted",
  "timeout",
  "budget_exceeded",
]);

function loopSnapshotPayload(
  payload: unknown,
  expectedRunId: string,
  expectedConfigFingerprint: string,
): LoopControllerSnapshot {
  if (payload === null || typeof payload !== "object") {
    throw new CoreMindError("run_state_corrupt", "RunState loop 缺少快照对象");
  }
  const snapshot = payload as Partial<LoopControllerSnapshot>;
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.machineVersion !== "1" ||
    snapshot.runId !== expectedRunId ||
    snapshot.configFingerprint !== expectedConfigFingerprint ||
    !LOOP_PHASES.has(snapshot.phase as LoopPhase) ||
    !isNonNegativeInteger(snapshot.iteration) ||
    !isNonNegativeInteger(snapshot.repairCount) ||
    !isNonNegativeInteger(snapshot.repeatedActionCount) ||
    !isNonNegativeInteger(snapshot.transitionSequence)
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 Loop 快照");
  }
  return snapshot as LoopControllerSnapshot;
}

function operationRecordPayload(payload: unknown, expectedRunId: string): OperationStateRecord {
  if (payload === null || typeof payload !== "object") {
    throw new CoreMindError("run_state_corrupt", "RunState operation 缺少状态记录");
  }
  const record = payload as Partial<OperationStateRecord>;
  if (record.schemaVersion !== 1 || record.runId !== expectedRunId) {
    throw new CoreMindError("run_state_corrupt", "RunState operation 与运行标识不一致");
  }
  return record as OperationStateRecord;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateRecord(value: unknown, expectedRunId: string): RunStateRecord {
  if (value === null || typeof value !== "object") {
    throw new CoreMindError("run_state_corrupt", `RunState ${expectedRunId} 包含非对象记录`);
  }
  const record = value as Partial<RunStateRecord>;
  if (
    record.version !== 1 ||
    record.runId !== expectedRunId ||
    !Number.isInteger(record.sequence) ||
    typeof record.timestamp !== "string" ||
    (record.eventId !== undefined &&
      (typeof record.eventId !== "string" || record.eventId.trim().length === 0)) ||
    ![
      "start",
      "resume",
      "telemetry_configuration",
      "telemetry_consent",
      "control",
      "delegation",
      "event",
      "checkpoint",
      "loop",
      "operation",
      "pause",
      "finish",
    ].includes(record.kind ?? "")
  ) {
    throw new CoreMindError("run_state_corrupt", `RunState ${expectedRunId} 包含非法记录`);
  }
  if (
    record.kind === "event" &&
    record.payload !== null &&
    typeof record.payload === "object" &&
    "event" in record.payload
  ) {
    tracePayload(record.payload, expectedRunId);
  }
  return record as RunStateRecord;
}

/** 从 RunState 事件记录中找第一个 input_receipt 的指纹（恢复时输入收据联动校验用） */
function findInputReceiptFingerprint(records: readonly RunStateRecord[]): string | undefined {
  for (const record of records) {
    if (record.kind !== "event") continue;
    const trace = record.payload as { event?: { type?: unknown; contentFingerprint?: unknown } };
    if (
      trace?.event?.type === "input_receipt" &&
      typeof trace.event.contentFingerprint === "string"
    ) {
      return trace.event.contentFingerprint;
    }
  }
  return undefined;
}
