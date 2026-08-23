import type { CheckpointRecord } from "./checkpoint.js";
import type { CoreMindEvent, EffectReceiptStatus } from "./events.js";
import { receiptId } from "./ids.js";
import { type OperationStateRecord, restoreDurableOperation } from "./operation-state.js";
import type { RunStateRecord } from "./run-state.js";

export type InvariantMode = "off" | "eval" | "gate";

export interface InvariantFacts {
  runRecords: readonly RunStateRecord[];
  checkpoints?: readonly CheckpointRecord[];
  session?: {
    sessionId: string;
    entries: readonly { id: string; seq: number }[];
  };
}

export interface InvariantViolation {
  invariant:
    | "I-1"
    | "I-2"
    | "I-3"
    | "I-4"
    | "I-5"
    | "I-6"
    | "I-7"
    | "I-8"
    | "I-9"
    | "I-10"
    | "I-11"
    | "I-12";
  message: string;
  runId?: string;
  sequence?: number;
  callId?: string;
  checkpointId?: string;
  approvalId?: string;
  receiptId?: string;
}

export function checkInvariantFacts(
  facts: InvariantFacts,
  options: { mode: InvariantMode } = { mode: "off" },
): InvariantViolation[] {
  if (options.mode === "off") return [];

  const violations: InvariantViolation[] = [];
  const recordsBySequence = new Map<string, RunStateRecord>();
  const latestSequenceByRun = new Map<string, number>();
  const finishedRunIds = new Set<string>();
  const interruptedRunIds = new Set<string>();
  const startedSteps = new Set<string>();
  const currentTurnByRun = new Map<string, string>();
  const openTurnByRun = new Map<string, string>();
  const implicitTurnsByRun = new Set<string>();
  const knownTurnsByRun = new Map<string, Set<string>>();
  const abortedRuns = new Set<string>();
  const turnsKnownAtAbort = new Map<string, ReadonlySet<string>>();
  const calls = new Map<string, { runId: string; callId: string; receiptId?: string }>();
  const terminalReceiptCounts = new Map<string, number>();
  const failedCallCounts = new Map<string, number>();
  const receiptStates = new Map<string, EffectReceiptStatus>();
  const receiptObservations = new Map<string, { runId: string; sequence: number }>();
  const pendingApprovals = new Map<string, { runId: string; sequence: number }>();
  const operationChains = new Map<string, OperationStateRecord[]>();
  for (const record of facts.runRecords) {
    const sequenceKey = `${record.runId}:${record.sequence}`;
    const existing = recordsBySequence.get(sequenceKey);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(record)) {
        violations.push({
          invariant: "I-2",
          message: `journal sequence ${record.sequence} 存在异内容记录`,
          runId: record.runId,
          sequence: record.sequence,
        });
      }
      continue;
    }
    recordsBySequence.set(sequenceKey, record);
    const expectedSequence = (latestSequenceByRun.get(record.runId) ?? 0) + 1;
    if (record.sequence !== expectedSequence) {
      violations.push({
        invariant: "I-1",
        message: `journal sequence 应为 ${expectedSequence}，实际为 ${record.sequence}`,
        runId: record.runId,
        sequence: record.sequence,
      });
    }
    latestSequenceByRun.set(record.runId, record.sequence);
    if (
      facts.session &&
      (record.kind === "start" || record.kind === "resume") &&
      record.payload !== null &&
      typeof record.payload === "object"
    ) {
      const association = record.payload as {
        sessionId?: unknown;
        sessionSeqStart?: unknown;
      };
      const sessionId = association.sessionId;
      if (typeof sessionId === "string" && sessionId !== facts.session.sessionId) {
        violations.push({
          invariant: "I-5",
          message: `Run 关联 Session ${sessionId} 与提供的 Session ${facts.session.sessionId} 不一致`,
          runId: record.runId,
          sequence: record.sequence,
        });
      }
      const maxSessionSequence = facts.session.entries.reduce(
        (maximum, entry) => Math.max(maximum, entry.seq),
        0,
      );
      if (
        typeof association.sessionSeqStart === "number" &&
        association.sessionSeqStart > maxSessionSequence
      ) {
        violations.push({
          invariant: "I-5",
          message: `sessionSeqStart ${association.sessionSeqStart} 超出 Session 水位 ${maxSessionSequence}`,
          runId: record.runId,
          sequence: record.sequence,
        });
      }
    }
    if (record.kind === "operation") {
      const identity = operationIdentity(record);
      if (identity) {
        const chain = operationChains.get(identity) ?? [];
        chain.push(record.payload as OperationStateRecord);
        operationChains.set(identity, chain);
      } else {
        violations.push({
          invariant: "I-11",
          message: "Operation 记录缺少有效身份",
          runId: record.runId,
          sequence: record.sequence,
        });
      }
    }
    const event = eventFrom(record);
    if (isAbortRequest(record)) {
      abortedRuns.add(record.runId);
      turnsKnownAtAbort.set(record.runId, new Set(knownTurnsByRun.get(record.runId) ?? []));
    }
    if (
      abortedRuns.has(record.runId) &&
      event !== undefined &&
      isLateTerminalEvent(event, turnsKnownAtAbort.get(record.runId))
    ) {
      violations.push({
        invariant: "I-10",
        message: "Abort 分界点后出现迟到终态事实",
        runId: record.runId,
        sequence: record.sequence,
      });
    }
    if (event?.type === "approval_required") {
      if (pendingApprovals.has(event.approvalId) || event.runId !== record.runId) {
        violations.push({
          invariant: "I-9",
          message: `ApprovalId ${event.approvalId} 的 required 事件重复或跨 Run`,
          runId: record.runId,
          sequence: record.sequence,
          approvalId: event.approvalId,
        });
      } else {
        pendingApprovals.set(event.approvalId, {
          runId: event.runId,
          sequence: record.sequence,
        });
      }
    }
    if (event?.type === "approval_resolved") {
      const required = pendingApprovals.get(event.approvalId);
      if (!required || required.runId !== event.runId || event.runId !== record.runId) {
        violations.push({
          invariant: "I-9",
          message: `ApprovalId ${event.approvalId} 没有匹配的 required 事件`,
          runId: record.runId,
          sequence: record.sequence,
          approvalId: event.approvalId,
        });
      } else {
        pendingApprovals.delete(event.approvalId);
      }
    }
    if (event?.type === "tool_call" && event.callId) {
      calls.set(callKey(record.runId, event.stepId, event.callId), {
        runId: record.runId,
        callId: event.callId,
        ...(event.idempotencyKey ? { receiptId: event.idempotencyKey } : {}),
      });
    }
    if (event?.type === "tool_result" && event.callId && event.isError) {
      const key = callKey(record.runId, event.stepId, event.callId);
      failedCallCounts.set(key, (failedCallCounts.get(key) ?? 0) + 1);
    }
    if (event?.type === "effect_receipt" && event.status !== "started") {
      terminalReceiptCounts.set(
        event.idempotencyKey,
        (terminalReceiptCounts.get(event.idempotencyKey) ?? 0) + 1,
      );
    }
    if (event?.type === "effect_receipt") {
      if (!receiptObservations.has(event.idempotencyKey)) {
        receiptObservations.set(event.idempotencyKey, {
          runId: record.runId,
          sequence: record.sequence,
        });
      }
      const expectedPrefix = event.stepId ? `${record.runId}:${event.stepId}:` : `${record.runId}:`;
      if (!event.idempotencyKey.startsWith(expectedPrefix)) {
        violations.push({
          invariant: "I-6",
          message: `ReceiptId ${event.idempotencyKey} 与当前 Run、Step 不匹配`,
          runId: record.runId,
          sequence: record.sequence,
          receiptId: event.idempotencyKey,
        });
      }
      const previous = receiptStates.get(event.idempotencyKey);
      if (!isLegalReceiptTransition(previous, event.status)) {
        violations.push({
          invariant: "I-12",
          message: `EffectReceipt ${event.idempotencyKey} 状态从 ${previous ?? "初始"} 非法迁移到 ${event.status}`,
          runId: record.runId,
          sequence: record.sequence,
          receiptId: event.idempotencyKey,
        });
      }
      receiptStates.set(event.idempotencyKey, event.status);
    }
    if (
      (event?.type === "tool_call" || event?.type === "tool_result") &&
      event.callId &&
      event.idempotencyKey &&
      event.idempotencyKey !== receiptId(record.runId, event.stepId, event.callId)
    ) {
      violations.push({
        invariant: "I-6",
        message: `ReceiptId ${event.idempotencyKey} 与当前 Run、Step、Call 不匹配`,
        runId: record.runId,
        sequence: record.sequence,
      });
    }
    if (event?.type === "agent_start" && event.turnId) {
      currentTurnByRun.set(record.runId, event.turnId);
      openTurnByRun.set(record.runId, event.turnId);
      implicitTurnsByRun.delete(record.runId);
      const knownTurns = knownTurnsByRun.get(record.runId) ?? new Set<string>();
      knownTurns.add(event.turnId);
      knownTurnsByRun.set(record.runId, knownTurns);
    }
    if (event?.type === "text_delta" && !currentTurnByRun.has(record.runId)) {
      implicitTurnsByRun.add(record.runId);
    }
    const correlatedTurnId = toolTurnIdFrom(event);
    if (correlatedTurnId && openTurnByRun.get(record.runId) !== correlatedTurnId) {
      violations.push({
        invariant: "I-5",
        message: `TurnId ${correlatedTurnId} 不属于当前开放 Turn`,
        runId: record.runId,
        sequence: record.sequence,
      });
    }
    if (event?.type === "turn_end" && event.turnId) {
      const currentTurnId = currentTurnByRun.get(record.runId);
      const implicitTurn = implicitTurnsByRun.has(record.runId);
      if (
        (currentTurnId !== undefined && currentTurnId !== event.turnId) ||
        (currentTurnId === undefined && !implicitTurn)
      ) {
        violations.push({
          invariant: "I-5",
          message: `TurnId ${event.turnId} 不属于当前活动 Turn`,
          runId: record.runId,
          sequence: record.sequence,
        });
      } else {
        currentTurnByRun.delete(record.runId);
        implicitTurnsByRun.delete(record.runId);
        openTurnByRun.set(record.runId, event.turnId);
        const knownTurns = knownTurnsByRun.get(record.runId) ?? new Set<string>();
        knownTurns.add(event.turnId);
        knownTurnsByRun.set(record.runId, knownTurns);
      }
    }
    if (event?.type === "step_start") {
      const stepKey = `${record.runId}:${event.stepId}`;
      const legacyLoopStep = event.stepId === "loop-execute" && !knownTurnsByRun.has(record.runId);
      if (startedSteps.has(stepKey) && !legacyLoopStep) {
        violations.push({
          invariant: "I-4",
          message: `StepId ${event.stepId} 在 Run 内重复启动`,
          runId: record.runId,
          sequence: record.sequence,
        });
      } else {
        startedSteps.add(stepKey);
      }
    }
    if (finishedRunIds.has(record.runId)) {
      violations.push({
        invariant: "I-3",
        message: "Run 终态之后仍存在新记录",
        runId: record.runId,
        sequence: record.sequence,
      });
    }
    if (record.kind === "finish") {
      finishedRunIds.add(record.runId);
      if (finishStatus(record) === "aborted" || finishStatus(record) === "timeout") {
        interruptedRunIds.add(record.runId);
      }
    }
  }
  for (const [key, call] of calls) {
    const receiptCount = call.receiptId ? (terminalReceiptCounts.get(call.receiptId) ?? 0) : 0;
    const terminationCount = receiptCount > 0 ? receiptCount : (failedCallCounts.get(key) ?? 0);
    if (terminationCount === 1 || (terminationCount === 0 && interruptedRunIds.has(call.runId))) {
      continue;
    }
    violations.push({
      invariant: "I-7",
      message: `工具 Call ${call.callId} 的可解释终结数量为 ${terminationCount}`,
      runId: call.runId,
      callId: call.callId,
    });
  }
  const knownReceiptIds = new Set(
    [...calls.values()].flatMap((call) => (call.receiptId ? [call.receiptId] : [])),
  );
  for (const [observedReceiptId, observation] of receiptObservations) {
    if (knownReceiptIds.has(observedReceiptId)) continue;
    violations.push({
      invariant: "I-6",
      message: `ReceiptId ${observedReceiptId} 无法回溯到工具 Call`,
      runId: observation.runId,
      sequence: observation.sequence,
      receiptId: observedReceiptId,
    });
  }
  for (const [approvalId, required] of pendingApprovals) {
    violations.push({
      invariant: "I-9",
      message: `ApprovalId ${approvalId} 缺少 resolved 事件`,
      runId: required.runId,
      sequence: required.sequence,
      approvalId,
    });
  }
  for (const chain of operationChains.values()) {
    try {
      restoreDurableOperation(chain);
    } catch (error) {
      violations.push({
        invariant: "I-11",
        message: `Operation 事件链非法：${String(error)}`,
        runId: chain[0]?.runId,
      });
    }
  }
  const runIds = new Set(facts.runRecords.map((record) => record.runId));
  const operationIds = new Set(
    facts.runRecords
      .filter((record) => record.kind === "operation")
      .map((record) => operationIdentity(record))
      .filter((identity): identity is string => identity !== undefined),
  );
  const callIds = new Set([...calls.values()].map((call) => `${call.runId}:${call.callId}`));
  for (const checkpoint of facts.checkpoints ?? []) {
    const runMismatch = !runIds.has(checkpoint.runId);
    const operationMismatch =
      checkpoint.operationId !== undefined &&
      !operationIds.has(`${checkpoint.runId}:${checkpoint.operationId}`);
    const callMismatch =
      checkpoint.toolCallId !== undefined &&
      !callIds.has(`${checkpoint.runId}:${checkpoint.toolCallId}`);
    const receiptMismatch =
      checkpoint.idempotencyKey !== undefined && !knownReceiptIds.has(checkpoint.idempotencyKey);
    if (!runMismatch && !operationMismatch && !callMismatch && !receiptMismatch) continue;
    violations.push({
      invariant: "I-8",
      message: `Checkpoint ${checkpoint.checkpointId} 与当前 Run 或 Operation 不匹配`,
      runId: checkpoint.runId,
      checkpointId: checkpoint.checkpointId,
    });
  }
  return violations;
}

function finishStatus(record: RunStateRecord): unknown {
  if (record.payload === null || typeof record.payload !== "object") return undefined;
  return (record.payload as { status?: unknown }).status;
}

function isLegalReceiptTransition(
  previous: EffectReceiptStatus | undefined,
  next: EffectReceiptStatus,
): boolean {
  if (previous === undefined) return next === "not_started" || next === "started";
  return previous === "started" && (next === "committed" || next === "unknown");
}

function isAbortRequest(record: RunStateRecord): boolean {
  if (
    record.kind !== "operation" ||
    record.payload === null ||
    typeof record.payload !== "object"
  ) {
    return false;
  }
  return (record.payload as { event?: unknown }).event === "REQUEST_ABORT";
}

function isLateTerminalEvent(
  event: CoreMindEvent,
  turnsKnownBeforeAbort: ReadonlySet<string> | undefined,
): boolean {
  if (event.type === "tool_result" || event.type === "turn_end") return true;
  if (event.type !== "effect_receipt" || event.status === "not_started") return false;
  return event.turnId === undefined || !turnsKnownBeforeAbort?.has(event.turnId);
}

function operationIdentity(record: RunStateRecord): string | undefined {
  if (record.payload === null || typeof record.payload !== "object") return undefined;
  const operation = record.payload as { runId?: unknown; operationId?: unknown };
  if (typeof operation.runId !== "string" || typeof operation.operationId !== "string") {
    return undefined;
  }
  return `${operation.runId}:${operation.operationId}`;
}

function callKey(runId: string, stepId: string | undefined, callId: string): string {
  return `${runId}:${stepId ?? "agent"}:${callId}`;
}

function toolTurnIdFrom(event: CoreMindEvent | undefined): string | undefined {
  if (
    event?.type === "tool_call" ||
    event?.type === "tool_result" ||
    event?.type === "effect_receipt"
  ) {
    return event.turnId;
  }
  return undefined;
}

function eventFrom(record: RunStateRecord): CoreMindEvent | undefined {
  if (record.kind !== "event" || record.payload === null || typeof record.payload !== "object") {
    return undefined;
  }
  const event = (record.payload as { event?: unknown }).event;
  if (
    event === null ||
    typeof event !== "object" ||
    typeof (event as { type?: unknown }).type !== "string"
  ) {
    return undefined;
  }
  return event as CoreMindEvent;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
