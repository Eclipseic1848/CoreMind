import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CoreMindError } from "./errors.js";
import type { LoopControllerSnapshot, LoopPhase } from "./loop-controller.js";
import type { CompletedWorkflowStep } from "./orchestrator.js";
import type { CoreMindTraceEvent } from "./trace.js";

export interface EffectReceipt {
  idempotencyKey: string;
  tool: string;
  status: "started" | "committed" | "unknown";
  stepId?: string;
}

export type RunStateKind =
  | "start"
  | "resume"
  | "event"
  | "checkpoint"
  | "loop"
  | "pause"
  | "finish";

export interface RunStateRecord {
  version: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  kind: RunStateKind;
  payload: unknown;
}

export interface RunStore {
  append(record: RunStateRecord): Promise<void>;
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
  previousTrace: CoreMindTraceEvent[];
  loopSnapshot?: LoopControllerSnapshot;
}

/** 本地 JSONL RunStore：每条记录只追加，不覆盖既有审计。 */
export class FileRunStore implements RunStore {
  constructor(readonly directory: string) {}

  pathFor(runId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new CoreMindError("invalid_run_id", `非法 runId：${runId}`);
    }
    return path.join(this.directory, `${runId}.jsonl`);
  }

  async append(record: RunStateRecord): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.pathFor(record.runId), `${JSON.stringify(record)}\n`, "utf8");
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "run_state_failed",
        `RunState 写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    let text: string;
    try {
      text = await readFile(this.pathFor(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "run_state_failed",
        `RunState 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      return text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => validateRecord(JSON.parse(line) as unknown, runId));
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "run_state_corrupt",
        `RunState ${runId} 已损坏：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export class MemoryRunStore implements RunStore {
  private readonly records = new Map<string, RunStateRecord[]>();

  async append(record: RunStateRecord): Promise<void> {
    const items = this.records.get(record.runId) ?? [];
    items.push(structuredClone(record));
    this.records.set(record.runId, items);
  }

  async read(runId: string): Promise<RunStateRecord[]> {
    return structuredClone(this.records.get(runId) ?? []);
  }
}

/** 把同步事件串行化为 RunStore 的有序异步写入。 */
export class RunStateJournal {
  private sequence: number;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    readonly runId: string,
    readonly store: RunStore,
    initialSequence = 0,
  ) {
    this.sequence = initialSequence;
  }

  async start(payload: unknown): Promise<void> {
    this.enqueue("start", payload);
    await this.flush();
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

  pause(payload: unknown): void {
    this.enqueue("pause", payload);
  }

  finish(payload: unknown): void {
    this.enqueue("finish", payload);
  }

  async flush(): Promise<void> {
    await this.pending;
  }

  private enqueue(kind: RunStateKind, payload: unknown): void {
    const record: RunStateRecord = {
      version: 1,
      runId: this.runId,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      kind,
      payload,
    };
    this.pending = this.pending.then(() => this.store.append(record));
  }
}

const REPLAY_SAFE_TOOLS = new Set(["read", "ls", "find", "grep", "web-fetch", "web-search"]);

/** 从中断的 append-only RunState 构造安全恢复计划。 */
export function prepareRunResume(
  records: RunStateRecord[],
  configFingerprint: string,
  requestedPrompt?: string,
): RunResumePlan {
  if (records.length === 0) throw new CoreMindError("unknown_run", "没有可恢复的 RunState");
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
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
  if (requestedPrompt !== undefined && requestedPrompt !== storedPrompt) {
    throw new CoreMindError("resume_input_mismatch", "恢复输入与原运行不一致，已拒绝恢复");
  }

  const completedSteps = new Map<string, CompletedWorkflowStep>();
  const unsafeToolStarts: Array<{ stepId?: string; tool: string; idempotencyKey?: string }> = [];
  const effectReceipts = new Map<string, EffectReceipt>();
  const previousTrace: CoreMindTraceEvent[] = [];
  let loopSnapshot: LoopControllerSnapshot | undefined;
  let nextTraceSequence = 0;
  for (const record of ordered) {
    if (record.kind === "loop") {
      loopSnapshot = loopSnapshotPayload(record.payload, record.runId, configFingerprint);
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
    if (event.type === "tool_call") {
      const toolEvent = event as {
        type: "tool_call";
        tool: string;
        stepId?: string;
        idempotencyKey?: string;
      };
      if (!REPLAY_SAFE_TOOLS.has(toolEvent.tool)) {
        unsafeToolStarts.push({
          tool: toolEvent.tool,
          ...(toolEvent.stepId ? { stepId: toolEvent.stepId } : {}),
          ...(toolEvent.idempotencyKey ? { idempotencyKey: toolEvent.idempotencyKey } : {}),
        });
      }
    }
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

  const unsafe = unsafeToolStarts.find(
    (toolCall) => !toolCall.stepId || !completedSteps.has(toolCall.stepId),
  );
  if (unsafe) {
    const receipt = unsafe.idempotencyKey ? effectReceipts.get(unsafe.idempotencyKey) : undefined;
    if (receipt?.status === "committed") {
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
    previousTrace,
    ...(loopSnapshot ? { loopSnapshot } : {}),
  };
}

/** 配置指纹只落 hash，不把配置或凭据复制进 RunState。 */
export function fingerprintRunConfig(config: unknown): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
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
      !["started", "committed", "unknown"].includes(String(event.status)) ||
      (event.stepId !== undefined && typeof event.stepId !== "string"))
  ) {
    throw new CoreMindError("run_state_corrupt", "RunState 包含非法 effect_receipt");
  }
  return trace as CoreMindTraceEvent;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
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
    !["start", "resume", "event", "checkpoint", "loop", "pause", "finish"].includes(
      record.kind ?? "",
    )
  ) {
    throw new CoreMindError("run_state_corrupt", `RunState ${expectedRunId} 包含非法记录`);
  }
  return record as RunStateRecord;
}
