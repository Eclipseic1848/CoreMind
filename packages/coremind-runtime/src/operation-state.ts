import { CoreMindError } from "./errors.js";

export type OperationState =
  | "accepted"
  | "running"
  | "paused"
  | "aborting"
  | "completed"
  | "failed";

export type OperationEventType =
  | "ACCEPT"
  | "START"
  | "PAUSE"
  | "RESUME"
  | "REQUEST_ABORT"
  | "COMPLETE"
  | "FAIL";

export interface OperationStateRecord {
  schemaVersion: 1;
  operationId: string;
  runId: string;
  correlationId: string;
  sequence: number;
  eventId: string;
  event: OperationEventType;
  from: OperationState | null;
  to: OperationState;
  timestamp: string;
  reason?: string;
}

export interface DurableOperationSnapshot {
  schemaVersion: 1;
  operationId: string;
  runId: string;
  correlationId: string;
  state: OperationState;
  transitionSequence: number;
  createdAt: string;
  updatedAt: string;
  pauseReason?: string;
  failureReason?: string;
}

export interface OperationEvent {
  eventId: string;
  type: Exclude<OperationEventType, "ACCEPT">;
  timestamp?: string;
  reason?: string;
}

export interface OperationTransitionResult {
  changed: boolean;
  snapshot: DurableOperationSnapshot;
  record?: OperationStateRecord;
}

const LEGAL_TRANSITIONS: Readonly<Record<OperationState, ReadonlySet<OperationState>>> = {
  accepted: new Set(["running", "aborting", "failed"]),
  running: new Set(["paused", "aborting", "completed", "failed"]),
  paused: new Set(["running", "aborting", "failed"]),
  aborting: new Set(["failed"]),
  completed: new Set(),
  failed: new Set(),
};

/**
 * 通用运行外围的持久操作状态，不复制 Workflow/Loop 的业务状态。
 * Loop 继续负责 planning/execute/verify/repair；本类只回答运行能否安全继续。
 */
export class DurableOperation {
  private readonly history: OperationStateRecord[];
  private readonly processedEventIds: Set<string>;
  private current: DurableOperationSnapshot;

  private constructor(snapshot: DurableOperationSnapshot, records: OperationStateRecord[]) {
    this.current = snapshot;
    this.history = records;
    this.processedEventIds = new Set(records.map((record) => record.eventId));
  }

  static create(options: {
    runId: string;
    operationId: string;
    eventId: string;
    correlationId?: string;
    timestamp?: string;
  }): DurableOperation {
    const timestamp = validTimestamp(options.timestamp);
    const correlationId = options.correlationId ?? `${options.runId}:${options.operationId}`;
    const record: OperationStateRecord = {
      schemaVersion: 1,
      operationId: nonEmpty(options.operationId, "operationId"),
      runId: nonEmpty(options.runId, "runId"),
      correlationId: nonEmpty(correlationId, "correlationId"),
      sequence: 1,
      eventId: nonEmpty(options.eventId, "eventId"),
      event: "ACCEPT",
      from: null,
      to: "accepted",
      timestamp,
    };
    return new DurableOperation(snapshotFrom([record]), [record]);
  }

  static canTransition(from: OperationState, to: OperationState): boolean {
    return LEGAL_TRANSITIONS[from].has(to);
  }

  static restore(records: readonly OperationStateRecord[]): DurableOperation {
    if (records.length === 0) {
      throw new CoreMindError("operation_state_corrupt", "Durable operation 缺少 accepted 记录");
    }
    const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
    const first = ordered[0]!;
    if (
      first.schemaVersion !== 1 ||
      first.sequence !== 1 ||
      first.event !== "ACCEPT" ||
      first.from !== null ||
      first.to !== "accepted"
    ) {
      throw new CoreMindError("operation_state_corrupt", "Durable operation 首条记录非法");
    }
    const eventIds = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
      const record = ordered[index]!;
      const previous = ordered[index - 1];
      if (
        record.schemaVersion !== 1 ||
        record.sequence !== index + 1 ||
        record.operationId !== first.operationId ||
        record.runId !== first.runId ||
        record.correlationId !== first.correlationId ||
        eventIds.has(record.eventId) ||
        Number.isNaN(Date.parse(record.timestamp)) ||
        (index > 0 &&
          (record.from !== previous?.to || !DurableOperation.canTransition(record.from, record.to)))
      ) {
        throw new CoreMindError(
          "operation_state_corrupt",
          "Durable operation 记录不连续或包含非法迁移",
        );
      }
      eventIds.add(record.eventId);
    }
    return new DurableOperation(snapshotFrom(ordered), structuredClone(ordered));
  }

  transition(event: OperationEvent): OperationTransitionResult {
    nonEmpty(event.eventId, "eventId");
    if (this.processedEventIds.has(event.eventId)) {
      return { changed: false, snapshot: this.snapshot() };
    }
    const to = targetState(event.type);
    if (!DurableOperation.canTransition(this.current.state, to)) {
      throw new CoreMindError(
        "invalid_operation_transition",
        `操作 ${this.current.operationId} 不能从 ${this.current.state} 迁移到 ${to}`,
      );
    }
    const record: OperationStateRecord = {
      schemaVersion: 1,
      operationId: this.current.operationId,
      runId: this.current.runId,
      correlationId: this.current.correlationId,
      sequence: this.current.transitionSequence + 1,
      eventId: event.eventId,
      event: event.type,
      from: this.current.state,
      to,
      timestamp: validTimestamp(event.timestamp),
      ...(event.reason === undefined ? {} : { reason: event.reason }),
    };
    this.history.push(record);
    this.processedEventIds.add(record.eventId);
    this.current = snapshotFrom(this.history);
    return { changed: true, snapshot: this.snapshot(), record: structuredClone(record) };
  }

  snapshot(): DurableOperationSnapshot {
    return structuredClone(this.current);
  }

  records(): OperationStateRecord[] {
    return structuredClone(this.history);
  }
}

export function restoreDurableOperation(
  records: readonly OperationStateRecord[],
): DurableOperation {
  return DurableOperation.restore(records);
}

function snapshotFrom(records: readonly OperationStateRecord[]): DurableOperationSnapshot {
  const first = records[0]!;
  const latest = records.at(-1)!;
  const latestPause = [...records].reverse().find((record) => record.to === "paused");
  const latestFailure = [...records].reverse().find((record) => record.to === "failed");
  return {
    schemaVersion: 1,
    operationId: first.operationId,
    runId: first.runId,
    correlationId: first.correlationId,
    state: latest.to,
    transitionSequence: latest.sequence,
    createdAt: first.timestamp,
    updatedAt: latest.timestamp,
    ...(latest.to === "paused" && latestPause?.reason ? { pauseReason: latestPause.reason } : {}),
    ...(latest.to === "failed" && latestFailure?.reason
      ? { failureReason: latestFailure.reason }
      : {}),
  };
}

function targetState(event: OperationEvent["type"]): OperationState {
  switch (event) {
    case "START":
    case "RESUME":
      return "running";
    case "PAUSE":
      return "paused";
    case "REQUEST_ABORT":
      return "aborting";
    case "COMPLETE":
      return "completed";
    case "FAIL":
      return "failed";
  }
}

function nonEmpty(value: string, label: string): string {
  if (value.trim() === "") {
    throw new CoreMindError("invalid_operation_state", `${label} 不能为空`);
  }
  return value;
}

function validTimestamp(value?: string): string {
  const timestamp = value ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new CoreMindError("invalid_operation_state", `非法时间戳：${timestamp}`);
  }
  return timestamp;
}
