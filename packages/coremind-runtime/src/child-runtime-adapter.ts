import path from "node:path";
import type {
  ChildRunExecutionAdapter,
  ChildRunExecutionInput,
  ChildRunResult,
  ChildRunWorkspaceChange,
} from "./child-run.js";
import { childRunInputFingerprint } from "./child-run.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindRuntime, RunResult } from "./runtime.js";
import { isRegisteredCoreMindRuntimeInstance } from "./runtime-instance-authority.js";

const CORE_MIND_CHILD_RUN_ADAPTER = Symbol("CoreMindChildRunAdapter");

export interface CoreMindChildRunAdapter extends ChildRunExecutionAdapter {
  readonly [CORE_MIND_CHILD_RUN_ADAPTER]: true;
}

export interface CoreMindChildRunAdapterOptions {
  createRuntime(input: ChildRunExecutionInput): Promise<CoreMindRuntime>;
  quiescenceTimeoutMs?: number;
}

/**
 * 把 Child Run 合同桥接到独立 CoreMindRuntime；工厂必须把 input.signal、childRunId 与
 * inheritedPolicy 映射进 Runtime 配置，不能在桥接层放宽权限或预算。
 */
export function createCoreMindChildRunAdapter(
  options: CoreMindChildRunAdapterOptions,
): CoreMindChildRunAdapter {
  return Object.freeze({
    [CORE_MIND_CHILD_RUN_ADAPTER]: true as const,
    execute: async (input: ChildRunExecutionInput) => {
      if (childRunInputFingerprint(input.request) !== input.inputFingerprint) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          "Child Runtime authority 与持久化 Delegation 输入指纹不一致",
        );
      }
      const runtime = await options.createRuntime(input);
      if (!isRegisteredCoreMindRuntimeInstance(runtime)) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          "Child Runtime 必须是由 CoreMindRuntime.create 创建的真实独立实例",
        );
      }
      await runtime.verifyChildRunAuthority(input);
      const result = await runtime.run();
      if (result.runId !== input.childRunId) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          `Child Runtime 返回 RunId ${result.runId}，期望 ${input.childRunId}`,
        );
      }
      if (!(await runtime.waitForQuiescence(options.quiescenceTimeoutMs))) {
        throw new CoreMindError(
          "child_run_not_quiescent",
          `Child Run ${input.childRunId} 在终态后仍未静止`,
        );
      }
      return childRunResultFromRuntime(result, input.request.workspace.canonicalRoot);
    },
  });
}

export function isCoreMindChildRunAdapter(
  value: ChildRunExecutionAdapter,
): value is CoreMindChildRunAdapter {
  return (value as Partial<CoreMindChildRunAdapter>)[CORE_MIND_CHILD_RUN_ADAPTER] === true;
}

function childRunResultFromRuntime(result: RunResult, canonicalRoot: string): ChildRunResult {
  assertChildResultOwnership(result);
  const checkpointReferences = result.checkpoints.map(
    (checkpoint) => `checkpoint:${checkpoint.checkpointId}`,
  );
  return {
    outcome: structuredClone(result.outcome),
    evidence: [...result.trace.map((entry) => `event:${entry.eventId}`), ...checkpointReferences],
    artifacts: (result.artifacts ?? result.snapshot.artifacts).map(
      (artifact) => artifact.artifactId,
    ),
    workspaceChanges: workspaceChangesFromCheckpoints(result, canonicalRoot),
    unresolvedRisks:
      result.outcome.error === undefined ? [] : [structuredClone(result.outcome.error.message)],
  };
}

function assertChildResultOwnership(result: RunResult): void {
  if (result.checkpoints.some((checkpoint) => checkpoint.runId !== result.runId)) {
    throw new CoreMindError(
      "child_run_identity_mismatch",
      `Child Run ${result.runId} 返回了其他 Run 的 Checkpoint`,
    );
  }
  const foreignReceipt = result.trace.find(
    (entry) =>
      entry.event.type === "effect_receipt" &&
      entry.event.binding !== undefined &&
      entry.event.binding.runId !== result.runId,
  );
  if (foreignReceipt) {
    throw new CoreMindError(
      "child_run_identity_mismatch",
      `Child Run ${result.runId} 返回了其他 Run 的 EffectReceipt`,
    );
  }
}

function workspaceChangesFromCheckpoints(
  result: RunResult,
  canonicalRoot: string,
): ChildRunWorkspaceChange[] {
  const changes: ChildRunWorkspaceChange[] = [];
  for (const checkpoint of result.checkpoints) {
    if (!checkpoint.reversible || checkpointWasNotStarted(result, checkpoint)) continue;
    if (!checkpoint.targetPath) {
      throw new CoreMindError(
        "checkpoint_failed",
        `Child Run ${result.runId} 的可逆 Checkpoint ${checkpoint.checkpointId} 缺少目标路径`,
      );
    }
    if (checkpoint.existed === undefined) {
      throw new CoreMindError(
        "checkpoint_failed",
        `Child Run ${result.runId} 的可逆 Checkpoint ${checkpoint.checkpointId} 缺少写前状态`,
      );
    }
    if (checkpoint.afterExisted === undefined) {
      throw new CoreMindError(
        "checkpoint_failed",
        `Child Run ${result.runId} 的可逆 Checkpoint ${checkpoint.checkpointId} 缺少写后状态`,
      );
    }
    const relativePath = path.relative(canonicalRoot, checkpoint.targetPath);
    if (
      relativePath.length === 0 ||
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      throw new CoreMindError(
        "child_run_identity_mismatch",
        `Child Run ${result.runId} 返回了 Workspace 外的 Checkpoint`,
      );
    }
    const kind = workspaceChangeKind(checkpoint);
    if (!kind) continue;
    changes.push({
      checkpointId: checkpoint.checkpointId,
      path: relativePath.split(path.sep).join("/"),
      kind,
      ...(checkpoint.beforeSha256 ? { beforeSha256: checkpoint.beforeSha256 } : {}),
      ...(checkpoint.afterSha256 ? { afterSha256: checkpoint.afterSha256 } : {}),
    });
  }
  return changes;
}

function checkpointWasNotStarted(
  result: RunResult,
  checkpoint: RunResult["checkpoints"][number],
): boolean {
  if (checkpoint.idempotencyKey === undefined || checkpoint.toolCallId === undefined) return false;
  const receipts = result.trace.flatMap((entry) => {
    if (entry.event.type !== "effect_receipt") return [];
    if (
      entry.event.idempotencyKey !== checkpoint.idempotencyKey ||
      entry.event.callId !== checkpoint.toolCallId
    ) {
      return [];
    }
    return [entry.event];
  });
  return (
    receipts.length > 0 &&
    receipts.every((receipt) => {
      const binding = receipt.binding;
      return (
        receipt.status === "not_started" &&
        receipt.tool === checkpoint.tool &&
        binding !== undefined &&
        binding.runId === result.runId &&
        binding.callId === checkpoint.toolCallId &&
        binding.callId === receipt.callId &&
        binding.tool === checkpoint.tool &&
        binding.tool === receipt.tool &&
        binding.agent === receipt.agent &&
        binding.turnId === receipt.turnId
      );
    })
  );
}

function workspaceChangeKind(
  checkpoint: RunResult["checkpoints"][number],
): ChildRunWorkspaceChange["kind"] | undefined {
  if (!checkpoint.existed && checkpoint.afterExisted) return "created";
  if (checkpoint.existed && !checkpoint.afterExisted) return "deleted";
  if (
    checkpoint.existed &&
    checkpoint.afterExisted &&
    checkpoint.beforeSha256 !== checkpoint.afterSha256
  ) {
    return "modified";
  }
  return undefined;
}
