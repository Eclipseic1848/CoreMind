import type { ArtifactRecord } from "coremind-tools";
import type { CheckpointRecord } from "./checkpoint.js";
import type { LifecycleExtensionReceipt } from "./lifecycle-extension.js";
import type { DurableOperationSnapshot } from "./operation-state.js";
import type { EvaluationReport, ReleaseReadiness, RunMetrics, RunOutcome } from "./result.js";
import type { CoreMindTraceEvent } from "./trace.js";

/** 所有入口共享的、纯 JSON 运行快照；不包含 Map、回调或 Provider 私有对象。 */
export interface RunSnapshot {
  schemaVersion: 1;
  runId: string;
  operation: DurableOperationSnapshot;
  outcome: RunOutcome;
  metrics: RunMetrics;
  evaluation: EvaluationReport;
  releaseReadiness: ReleaseReadiness;
  trace: CoreMindTraceEvent[];
  checkpoints: CheckpointRecord[];
  artifacts: ArtifactRecord[];
  extensions: LifecycleExtensionReceipt[];
  resumable: boolean;
}

export type RunSnapshotInput = Omit<RunSnapshot, "schemaVersion" | "resumable">;

/** 在 Runtime 终态确定后生成唯一快照，供 CLI、Worker 与两个 SDK 原样传递。 */
export function createRunSnapshot(input: RunSnapshotInput): RunSnapshot {
  if (input.operation.runId !== input.runId) {
    throw new Error("RunSnapshot 的 operation.runId 与 runId 不一致");
  }
  return structuredClone({
    schemaVersion: 1 as const,
    ...input,
    resumable:
      input.operation.state === "paused" &&
      input.outcome.status === "paused" &&
      hasSafeResumeBoundary(input.trace),
  });
}

/** 快照只在所有未完成副作用都有明确未开始收据时宣称可恢复。 */
function hasSafeResumeBoundary(trace: readonly CoreMindTraceEvent[]): boolean {
  const receipts = new Map<string, "not_started" | "started" | "committed" | "unknown">();
  const completedSteps = new Set<string>();
  for (const entry of trace) {
    const event = entry.event;
    if (event.type === "effect_receipt") receipts.set(event.idempotencyKey, event.status);
    if (event.type === "step_output") completedSteps.add(event.stepId);
  }
  return !trace.some(({ event }) => {
    if (event.type !== "tool_call" || !event.idempotencyKey) return false;
    if (event.stepId && completedSteps.has(event.stepId)) return false;
    return receipts.get(event.idempotencyKey) !== "not_started";
  });
}
