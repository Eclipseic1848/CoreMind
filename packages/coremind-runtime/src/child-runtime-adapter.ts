import path from "node:path";
import type { RecoveryDisposition } from "coremind-tools";
import type {
  ChildRunExecutionAdapter,
  ChildRunExecutionInput,
  ChildRunRecoveryAssessment,
  ChildRunResult,
  ChildRunWorkspaceChange,
} from "./child-run.js";
import {
  childRunInputFingerprint,
  childRunRecoveryAssessment as normalizePersistedChildRunRecovery,
} from "./child-run.js";
import { validateEffectReceiptBindingsAgainstFacts } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindRuntime, RunResult } from "./runtime.js";
import { isRegisteredCoreMindRuntimeInstance } from "./runtime-instance-authority.js";
import { projectToolCapabilities } from "./tool-capability-projection.js";

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
    recovery: childRunRecoveryAssessment(result),
  };
}

function childRunRecoveryAssessment(result: RunResult): ChildRunRecoveryAssessment {
  const direct = directChildRunRecoveryAssessment(result);
  const tree = result.childRuns;
  if (!tree) return direct;

  const descendants = tree.nodes.map((node): ChildRunRecoveryAssessment => {
    if (node.status !== "joined" || !node.result) {
      return {
        recoveryDisposition: "requires_human",
        effectState: "unknown",
        quiescent: false,
        executionOwnership: "unknown",
        evidence: [`child_run:${node.childRunId}:result_missing`],
      };
    }
    if (!node.result.recovery) {
      return {
        recoveryDisposition: "requires_human",
        effectState: "unknown",
        quiescent: true,
        executionOwnership: "released",
        evidence: [`child_run:${node.childRunId}:recovery_missing`],
      };
    }
    const recovery = normalizePersistedChildRunRecovery(node.result);
    return {
      ...recovery,
      evidence: recovery.evidence.map((evidence) => `child_run:${node.childRunId}:${evidence}`),
    };
  });
  const executionQuiescent =
    tree.activeDescendants === 0 && descendants.every((assessment) => assessment.quiescent);
  const executionOwnership =
    descendants.every((assessment) => assessment.executionOwnership === "released") &&
    direct.executionOwnership === "released"
      ? "released"
      : "unknown";
  const assessments = [direct, ...descendants];
  let recoveryDisposition = assessments.reduce<RecoveryDisposition>(
    (current, assessment) =>
      recoveryDispositionRank(assessment.recoveryDisposition) > recoveryDispositionRank(current)
        ? assessment.recoveryDisposition
        : current,
    "replay_safe",
  );
  if (tree.unhandledDescendants > 0 || !executionQuiescent || executionOwnership === "unknown") {
    if (recoveryDispositionRank("requires_human") > recoveryDispositionRank(recoveryDisposition)) {
      recoveryDisposition = "requires_human";
    }
  }
  const effectState = assessments.reduce<ChildRunRecoveryAssessment["effectState"]>(
    (current, assessment) =>
      effectStateRank(assessment.effectState) > effectStateRank(current)
        ? assessment.effectState
        : current,
    "none",
  );
  return {
    recoveryDisposition,
    effectState,
    quiescent: direct.quiescent && executionQuiescent,
    executionOwnership,
    evidence: [
      ...new Set([
        ...direct.evidence,
        ...descendants.flatMap((assessment) => assessment.evidence),
        ...(tree.unhandledDescendants > 0 ? ["child_run_tree:unhandled_descendants"] : []),
      ]),
    ],
  };
}

function directChildRunRecoveryAssessment(result: RunResult): ChildRunRecoveryAssessment {
  const events = result.trace.map((entry) => entry.event);
  const hasToolEvidence = events.some((event) =>
    [
      "tool_call",
      "tool_result",
      "tool_attempt",
      "capability_resolved",
      "workspace_lease",
      "effect_receipt",
      "tool_lifecycle",
    ].includes(event.type),
  );
  const hasToolCall = events.some((event) => event.type === "tool_call");
  if (!hasToolEvidence) {
    return {
      recoveryDisposition: "replay_safe",
      effectState: "none",
      quiescent: true,
      executionOwnership: "released",
      evidence: ["trace:no_tool_calls", "runtime:quiescent", "execution_ownership:released"],
    };
  }
  if (!hasToolCall) {
    return {
      recoveryDisposition: "requires_human",
      effectState: "unknown",
      quiescent: true,
      executionOwnership: "released",
      evidence: [
        ...result.trace.map((entry) => `event:${entry.eventId}`),
        "trace:tool_call_missing",
        "runtime:quiescent",
        "execution_ownership:released",
      ],
    };
  }
  const capabilities = projectToolCapabilities(events);
  const receiptBindings = validateEffectReceiptBindingsAgainstFacts(result.runId, events);
  const receiptByCall = new Map(
    receiptBindings.flatMap((receipt) =>
      receipt.provenance === "bound" && receipt.binding
        ? [
            [
              toolCallKey(receipt.binding.agent, receipt.binding.stepId, receipt.binding.callId),
              receipt,
            ] as const,
          ]
        : [],
    ),
  );
  const assessments: Array<
    Pick<ChildRunRecoveryAssessment, "recoveryDisposition" | "effectState">
  > = capabilities.map(({ agent, callId, stepId, capability, recoveryDisposition }) => {
    const receipt =
      callId === undefined ? undefined : receiptByCall.get(toolCallKey(agent, stepId, callId));
    if (receipt?.status === "not_started") {
      return { recoveryDisposition: "replay_safe" as const, effectState: "not_started" as const };
    }
    if (receipt !== undefined) {
      return {
        recoveryDisposition:
          recoveryDisposition === "replay_safe" ? ("requires_human" as const) : recoveryDisposition,
        effectState: receipt.status,
      };
    }
    if (capability.effect === "none" && recoveryDisposition === "replay_safe") {
      return { recoveryDisposition: "replay_safe" as const, effectState: "none" as const };
    }
    return {
      recoveryDisposition,
      effectState: "unknown" as const,
    };
  });
  const hasUnboundReceipt = receiptBindings.some((receipt) => receipt.provenance === "legacy");
  if (hasUnboundReceipt) {
    assessments.push({ recoveryDisposition: "requires_human", effectState: "unknown" });
  }
  const recoveryDisposition = assessments.reduce<RecoveryDisposition>(
    (current, assessment) =>
      recoveryDispositionRank(assessment.recoveryDisposition) > recoveryDispositionRank(current)
        ? assessment.recoveryDisposition
        : current,
    "replay_safe",
  );
  const effectState = assessments.reduce<ChildRunRecoveryAssessment["effectState"]>(
    (current, assessment) =>
      effectStateRank(assessment.effectState) > effectStateRank(current)
        ? assessment.effectState
        : current,
    "none",
  );
  const boundReceiptIds = new Set(
    receiptBindings.flatMap((receipt) =>
      receipt.provenance === "bound" ? [receipt.idempotencyKey] : [],
    ),
  );
  return {
    recoveryDisposition,
    effectState,
    quiescent: true,
    executionOwnership: "released",
    evidence: [
      ...result.trace
        .filter((entry) => entry.event.type === "capability_resolved")
        .map((entry) => `event:${entry.eventId}`),
      ...result.trace
        .filter(
          (entry) =>
            entry.event.type === "effect_receipt" &&
            boundReceiptIds.has(entry.event.idempotencyKey),
        )
        .map((entry) => `event:${entry.eventId}`),
      ...(hasUnboundReceipt ? ["trace:unbound_effect_receipt"] : []),
      "runtime:quiescent",
      "execution_ownership:released",
    ],
  };
}

function toolCallKey(agent: string, stepId: string | undefined, callId: string): string {
  return `${agent}\u0000${stepId ?? ""}\u0000${callId}`;
}

function recoveryDispositionRank(disposition: RecoveryDisposition): number {
  return {
    replay_safe: 0,
    requires_proof: 1,
    requires_human: 2,
    forbidden: 3,
  }[disposition];
}

function effectStateRank(state: ChildRunRecoveryAssessment["effectState"]): number {
  return {
    none: 0,
    not_started: 1,
    committed: 2,
    started: 3,
    unknown: 4,
  }[state];
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
