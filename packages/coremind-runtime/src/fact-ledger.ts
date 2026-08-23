import { randomUUID } from "node:crypto";
import { CoreMindError } from "./errors.js";
import type {
  RunStateKind,
  RunStateRecord,
  RunStore,
  RunStoreDurability,
  RunStoreDurabilityAcknowledgement,
} from "./run-state.js";

export interface FactAppendOptions {
  durability?: RunStoreDurability;
  eventId?: string;
}

export interface FactDurabilityReceipt {
  runId: string;
  sequence: number;
  eventId: string;
  kind: RunStateKind;
  durability: RunStoreDurability;
  acknowledgement: RunStoreDurabilityAcknowledgement;
  latencyMs: number;
  acknowledgedAt: string;
}

export interface FactLedgerLevelMetrics {
  succeeded: number;
  failed: number;
  totalLatencyMs: number;
  maxLatencyMs: number;
}

export interface FactLedgerMetrics {
  pending: number;
  ordinary: FactLedgerLevelMetrics;
  critical: FactLedgerLevelMetrics;
}

export type FactLedgerStatus =
  | { state: "healthy"; nextSequence: number; terminal: boolean }
  | { state: "poisoned"; failedSequence: number; reason: string };

/**
 * 单个 Run 的权威 Fact 提交队列。
 *
 * 每次 append 都返回绑定该 sequence/eventId 的 Store acknowledgement；任何失败都会显式
 * poison 当前实例，阻止后续预留 sequence 被静默提交。恢复必须从 Store 稳定前缀建立新实例。
 */
export class FactLedger {
  private nextSequence: number;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private terminal = false;
  private terminalReserved = false;
  private poison?: { failedSequence: number; reason: string; error: unknown };
  private readonly counters: FactLedgerMetrics = {
    pending: 0,
    ordinary: { succeeded: 0, failed: 0, totalLatencyMs: 0, maxLatencyMs: 0 },
    critical: { succeeded: 0, failed: 0, totalLatencyMs: 0, maxLatencyMs: 0 },
  };

  constructor(
    readonly runId: string,
    readonly store: RunStore,
    initialSequence = 0,
  ) {
    this.nextSequence = initialSequence + 1;
  }

  append(
    kind: RunStateKind,
    payload: unknown,
    options: FactAppendOptions = {},
  ): Promise<FactDurabilityReceipt> {
    if (this.poison) return handledRejection(this.poisonedError());
    if (this.terminalReserved) {
      return handledRejection(
        new CoreMindError("fact_ledger_terminal", `Run ${this.runId} 已写入终态 Fact`),
      );
    }

    const durability = options.durability ?? "ordinary";
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const eventId = options.eventId ?? randomUUID();
    const record: RunStateRecord = {
      version: 1,
      runId: this.runId,
      sequence,
      eventId,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    };
    if (kind === "pause" || kind === "finish") this.terminalReserved = true;
    this.pending += 1;
    this.counters.pending = this.pending;

    const task = this.tail.then(async () => {
      const startedAt = performance.now();
      try {
        if (this.poison) throw this.poisonedError();
        const acknowledgement = await commitFact(this.store, record, durability);
        validateAcknowledgement(this.store, durability, acknowledgement);
        const latencyMs = Math.max(0, performance.now() - startedAt);
        const metrics = this.counters[durability];
        metrics.succeeded += 1;
        metrics.totalLatencyMs += latencyMs;
        metrics.maxLatencyMs = Math.max(metrics.maxLatencyMs, latencyMs);
        if (kind === "pause" || kind === "finish") this.terminal = true;
        return {
          runId: this.runId,
          sequence,
          eventId,
          kind,
          durability,
          acknowledgement,
          latencyMs,
          acknowledgedAt: new Date().toISOString(),
        } satisfies FactDurabilityReceipt;
      } catch (error) {
        // 保留首个 Store 失败作为权威根因；已排队的后续 Fact 只观测 poison，
        // 不得改写 failedSequence，也不计为新的 commit 失败。
        if (!this.poison) {
          this.counters[durability].failed += 1;
          this.poison = {
            failedSequence: sequence,
            reason: error instanceof Error ? error.message : String(error),
            error,
          };
        }
        throw error;
      } finally {
        this.pending -= 1;
        this.counters.pending = this.pending;
      }
    });
    // tail 始终收敛，避免调用方稍后 flush 时产生异步未处理拒绝；原 task 仍向调用方返回失败。
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    void task.catch(() => undefined);
    return task;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.poison) throw this.poison.error;
  }

  status(): FactLedgerStatus {
    return this.poison
      ? {
          state: "poisoned",
          failedSequence: this.poison.failedSequence,
          reason: this.poison.reason,
        }
      : { state: "healthy", nextSequence: this.nextSequence, terminal: this.terminal };
  }

  metrics(): FactLedgerMetrics {
    return structuredClone(this.counters);
  }

  private poisonedError(): CoreMindError {
    return new CoreMindError(
      "fact_ledger_poisoned",
      `FactLedger 在 sequence ${this.poison?.failedSequence ?? "unknown"} 后已 poisoned：${
        this.poison?.reason ?? "unknown"
      }`,
    );
  }
}

function handledRejection<T>(error: unknown): Promise<T> {
  const rejection = Promise.reject<T>(error);
  void rejection.catch(() => undefined);
  return rejection;
}

async function commitFact(
  store: RunStore,
  record: RunStateRecord,
  durability: RunStoreDurability,
): Promise<RunStoreDurabilityAcknowledgement> {
  if (store.commit) return store.commit(record, durability);
  const supported = store.supportedDurability ?? ["ordinary"];
  if (!supported.includes(durability) || durability === "critical") {
    throw new CoreMindError(
      "durability_unsupported",
      "RunStore 未实现绑定单条 Fact 的 critical commit acknowledgement",
    );
  }
  await store.append(record);
  return {
    requested: "ordinary",
    achieved: "ordinary",
    boundary: store.durabilityBoundary ?? "process_memory",
  };
}

function validateAcknowledgement(
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
    `RunStore 返回了与 Fact ${requested}/${boundary} 不一致的 acknowledgement`,
  );
}
