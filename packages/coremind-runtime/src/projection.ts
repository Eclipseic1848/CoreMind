import {
  type ArtifactRecord,
  isResolvedToolCapability,
  RECOVERY_DISPOSITIONS,
  recoveryDispositionFor,
} from "coremind-tools";
import { canonicalJson } from "./canonical-json.js";
import type { CheckpointRecord } from "./checkpoint.js";
import {
  type ChildRunBudgetAllocation,
  type ChildRunModelSnapshot,
  type ChildRunPermissionSnapshot,
  type ChildRunResult,
  type ChildRunWorkspaceSnapshot,
  childRunRecoveryAssessment,
  childRunResultFingerprint,
  childRunResultRequiresDisposition,
  decodeChildRunFact,
  delegationDispositionViolation,
  foldChildRunLifecycleStatus,
  isChildRunRecoverySafeForRedelegation,
} from "./child-run.js";
import { type PendingControlProjection, projectPendingControlFacts } from "./control-inbox.js";
import { CoreMindError } from "./errors.js";
import { LIFECYCLE_EVENTS, type LifecycleExtensionReceipt } from "./lifecycle-extension.js";
import {
  type LocalObservabilityProjection,
  projectLocalObservability,
  validateTelemetryConsentFact,
} from "./observability.js";
import type { DurableOperationSnapshot } from "./operation-state.js";
import type { EvaluationReport, ReleaseReadiness, RunMetrics, RunOutcome } from "./result.js";
import {
  isRunStateResumable,
  operationSnapshotFromRecords,
  prepareRunResume,
  type RunResumePlan,
  type RunStateRecord,
  type RunStore,
} from "./run-state.js";
import { createRunSnapshot, type RunSnapshot } from "./snapshot.js";
import { validateToolCallLifecycleFact } from "./tool-call-lifecycle.js";
import type { CoreMindTraceEvent } from "./trace.js";
import {
  projectWorkspaceLeasesFromRecords,
  type WorkspaceLeaseProjection,
} from "./workspace-lease.js";

export type RunProjectionStatus = "finished" | "paused" | "interrupted";

export interface PendingApprovalControl {
  type: "approval";
  approvalId: string;
  runId: string;
  agent: string;
  tool: string;
  risk: "low" | "high";
}

export type PendingControl = PendingApprovalControl | PendingControlProjection;

export interface RecoveryDecision {
  resumable: boolean;
  requiresHuman: boolean;
  operation?: DurableOperationSnapshot;
}

export interface ContextProjection {
  stablePrefixes: Array<{ agent: string; fingerprint: string }>;
  budgets: Array<{
    providerId: string;
    modelId: string;
    capabilityFingerprint: string;
    source: "locked_catalog" | "explicit_config" | "provider_metadata" | "conservative_fallback";
    confidence: "verified" | "declared" | "assumed";
    effectiveContextWindow: number;
    reservedOutputTokens: number;
    availableInputTokens: number;
    messageTokens: number;
    estimator: "pi-agent-core-estimate-v1";
  }>;
  compactions: Array<{
    beforeTokens: number;
    afterTokens: number;
    removedMessages: number;
    strategy: "deterministic-v1" | "task-state-v1";
    reason: "threshold";
    summaryFingerprint: string;
    sessionEntryId?: string;
    capabilityFingerprint?: string;
    lineageDepth?: number;
    rebuiltFromCanonical?: boolean;
    trigger?: "threshold" | "model_switch" | "provider_overflow";
  }>;
  failures: Array<{ message: string; preservedMessages: number }>;
  lifecycleFailures: Array<{
    code: string;
    reason: string;
    pausable: boolean;
    preservedMessages: number;
    providerCallBlocked: true;
  }>;
}

export type ArtifactProjection = Omit<ArtifactRecord, "createdAt" | "retention"> &
  Partial<Pick<ArtifactRecord, "createdAt" | "retention">>;

export interface RunProjection {
  schemaVersion: 1;
  runId: string;
  status: RunProjectionStatus;
  resumable: boolean;
  operation?: DurableOperationSnapshot;
  outcome?: RunOutcome;
  recovery: RecoveryDecision;
  trace: CoreMindTraceEvent[];
  checkpoints: CheckpointRecord[];
  artifacts: ArtifactProjection[];
  extensions: LifecycleExtensionReceipt[];
  context: ContextProjection;
  pendingControls: PendingControl[];
  childRuns?: ChildRunTreeProjection;
  observability: LocalObservabilityProjection;
  records: RunStateRecord[];
  snapshot?: RunSnapshot;
}

export interface ChildRunNodeProjection {
  parentRunId: string;
  childRunId: string;
  delegationId: string;
  predecessorDelegationId?: string;
  agentName: string;
  inputFingerprint: string;
  budget: ChildRunBudgetAllocation;
  permissions: ChildRunPermissionSnapshot;
  model: ChildRunModelSnapshot;
  workspace: ChildRunWorkspaceSnapshot;
  workspaceLeases?: WorkspaceLeaseProjection[];
  status: "recorded" | "created" | "running" | "terminal" | "paused" | "orphaned" | "joined";
  outcome?: RunOutcome;
  result?: ChildRunResult;
  recovery?: RecoveryDecision;
  disposition?: ChildRunDispositionProjection;
}

export interface ChildRunDispositionProjection {
  state:
    | "not_required"
    | "required"
    | "recorded"
    | "awaiting_redelegation"
    | "redelegation_cancelled";
  requiredActor?: "parent_agent" | "human";
  action?: "accept_failure" | "choose_alternative" | "redelegate" | "propagate_terminal";
  decidedBy?: "parent_agent" | "human";
  reason?: string;
  recoveryDisposition: "replay_safe" | "requires_proof" | "requires_human" | "forbidden";
  successorDelegationId?: string;
  parentTerminalCode?: string;
  cancellationReason?: string;
}

export interface ChildRunTreeProjection {
  nodes: ChildRunNodeProjection[];
  activeDescendants: number;
  unhandledDescendants: number;
  quiescent: boolean;
}

/** 从 append-only Run Facts 生成可删除、可重建的唯一运行投影。 */
export const ProjectionEngine = {
  project(records: readonly RunStateRecord[]): RunProjection {
    if (records.length === 0) {
      throw new CoreMindError("unknown_run", "没有可投影的 Run Facts");
    }
    const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
    const runId = ordered[0]!.runId;
    for (const [index, record] of ordered.entries()) {
      if (record.runId !== runId || record.sequence !== index + 1) {
        throw new CoreMindError("run_state_corrupt", "Run Facts 身份或 sequence 不连续");
      }
      if (record.kind === "telemetry_consent") validateTelemetryConsentFact(record.payload);
    }

    const trace = ordered.flatMap((record) => {
      if (record.kind !== "event") return [];
      if (!isTraceEvent(record.payload, runId)) {
        throw new CoreMindError("run_state_corrupt", "Run Fact 包含损坏的 event payload");
      }
      return [record.payload];
    });
    const lastResumeSequence = [...ordered]
      .reverse()
      .find((record) => record.kind === "resume")?.sequence;
    const terminal = [...ordered]
      .reverse()
      .find(
        (record) =>
          (lastResumeSequence === undefined || record.sequence > lastResumeSequence) &&
          (record.kind === "finish" || record.kind === "pause"),
      );
    const status: RunProjectionStatus =
      terminal?.kind === "finish"
        ? "finished"
        : terminal?.kind === "pause"
          ? "paused"
          : "interrupted";
    if (terminal && !isRecord(terminal.payload)) {
      throw new CoreMindError("run_state_corrupt", "Run Fact 包含损坏的 terminal payload");
    }
    const terminalPayload = terminal?.payload as Record<string, unknown> | undefined;
    const terminalOperation = terminalField(terminalPayload, "operation", (value) =>
      asOperation(value, runId),
    );
    const operation = terminalOperation ?? operationSnapshotFromRecords(ordered);
    const outcome = terminalField(terminalPayload, "outcome", asRunOutcome);
    const metrics = terminalField(terminalPayload, "metrics", asRunMetrics);
    const evaluation = terminalField(terminalPayload, "evaluation", asEvaluationReport);
    const releaseReadiness = terminalField(terminalPayload, "releaseReadiness", asReleaseReadiness);
    const checkpoints = projectCheckpoints(ordered, runId);
    const exactArtifacts = terminalField(terminalPayload, "artifacts", asArtifactRecords);
    const artifacts = exactArtifacts ?? projectArtifacts(trace);
    const extensions =
      terminalField(terminalPayload, "extensions", asExtensionReceipts) ?? projectExtensions(trace);
    const requiresHuman = outcome?.error?.code === "unclassified_error";
    const recovery: RecoveryDecision = {
      resumable: isRunStateResumable(ordered) && !requiresHuman,
      requiresHuman,
      ...(operation ? { operation } : {}),
    };
    const snapshot = projectSnapshot({
      runId,
      operation,
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      trace,
      checkpoints,
      artifacts: exactArtifacts ?? (artifacts.length === 0 ? [] : undefined),
      extensions,
    });
    const context = projectContext(trace);
    const pendingControls = [
      ...projectPendingApprovals(trace),
      ...projectPendingControlFacts(runId, ordered),
    ];
    const childRuns = projectChildRuns(ordered, runId);
    const observability = projectLocalObservability(ordered, {
      runStatus: status,
      resumable: recovery.resumable,
      ...(operation ? { operationState: operation.state } : {}),
      context: {
        budgets: context.budgets.length,
        compactions: context.compactions.length,
        failures: context.failures.length + context.lifecycleFailures.length,
      },
      artifacts: {
        stored: artifacts.filter((artifact) => artifact.status === "stored").length,
        blocked: artifacts.filter((artifact) => artifact.status === "blocked").length,
      },
      pendingControls: pendingControls.length,
    });

    return structuredClone({
      schemaVersion: 1 as const,
      runId,
      status,
      resumable: recovery.resumable,
      ...(operation ? { operation } : {}),
      ...(outcome ? { outcome } : {}),
      recovery,
      trace,
      checkpoints,
      artifacts,
      extensions,
      context,
      pendingControls,
      ...(childRuns ? { childRuns } : {}),
      observability,
      records: ordered,
      ...(snapshot ? { snapshot } : {}),
    });
  },

  prepareResume(
    records: readonly RunStateRecord[],
    configFingerprint: string,
    requestedPrompt?: string,
  ): RunResumePlan {
    if (records.length === 0) {
      return prepareRunResume([], configFingerprint, requestedPrompt);
    }
    const projection = ProjectionEngine.project(records);
    if (projection.recovery.requiresHuman) {
      throw new CoreMindError(
        "unclassified_error",
        "运行包含未分类外部错误，必须人工审计并通过显式处置流程继续",
      );
    }
    const plan = prepareRunResume([...records], configFingerprint, requestedPrompt);
    if (!projection.recovery.resumable) {
      throw new CoreMindError("run_state_corrupt", "Projection 与恢复计划的准入结果不一致");
    }
    return plan;
  },

  async projectTree(store: RunStore, rootRunId: string): Promise<RunProjection> {
    const root = this.project(await store.read(rootRunId));
    const visited = new Set([rootRunId]);
    const nodes: ChildRunNodeProjection[] = [];

    const collect = async (projection: RunProjection): Promise<void> => {
      for (const sourceNode of projection.childRuns?.nodes ?? []) {
        const node = structuredClone(sourceNode);
        nodes.push(node);
        if (visited.has(node.childRunId)) {
          throw new CoreMindError("run_state_corrupt", "Child Run tree 包含循环或重复 ChildRunId");
        }
        visited.add(node.childRunId);
        const childRecords = await store.read(node.childRunId);
        if (childRecords.length === 0) continue;
        const childProjection = this.project(childRecords);
        node.recovery = structuredClone(childProjection.recovery);
        const workspaceLeases = projectWorkspaceLeasesFromRecords(childRecords);
        if (workspaceLeases.length > 0) node.workspaceLeases = workspaceLeases;
        await collect(childProjection);
      }
    };
    await collect(root);
    if (nodes.length === 0) return root;
    const activeDescendants = nodes.filter(
      (node) => node.status === "created" || node.status === "running",
    ).length;
    const unhandledDescendants = nodes.filter(childRunNodeIsUnhandled).length;
    return {
      ...root,
      childRuns: {
        nodes,
        activeDescendants,
        unhandledDescendants,
        quiescent: unhandledDescendants === 0,
      },
    };
  },
};

function projectChildRuns(
  records: readonly RunStateRecord[],
  parentRunId: string,
): ChildRunTreeProjection | undefined {
  const nodes = new Map<string, ChildRunNodeProjection>();
  for (const record of records) {
    if (record.kind !== "delegation") continue;
    const fact = decodeChildRunFact(record.payload);
    if (!fact) {
      throw new CoreMindError("run_state_corrupt", "Run Fact 包含损坏的 delegation payload");
    }
    if (fact.parentRunId !== parentRunId) {
      throw new CoreMindError("run_state_corrupt", "Delegation Fact 的父 Run 身份不一致");
    }
    const existing = nodes.get(fact.delegationId);
    if (fact.type === "delegation_recorded") {
      if (existing) {
        throw new CoreMindError("run_state_corrupt", "同一 DelegationId 存在重复 recorded Fact");
      }
      if (fact.predecessorDelegationId) {
        const predecessor = nodes.get(fact.predecessorDelegationId);
        if (
          predecessor?.disposition?.state !== "awaiting_redelegation" ||
          predecessor.disposition.action !== "redelegate" ||
          predecessor.disposition.successorDelegationId !== undefined ||
          predecessor.disposition.recoveryDisposition !== "replay_safe"
        ) {
          throw new CoreMindError("run_state_corrupt", "关联 Child Run 缺少匹配的安全重新委派处置");
        }
        predecessor.disposition.state = "recorded";
        predecessor.disposition.successorDelegationId = fact.delegationId;
      }
      nodes.set(fact.delegationId, {
        parentRunId,
        childRunId: fact.childRunId,
        delegationId: fact.delegationId,
        ...(fact.predecessorDelegationId
          ? { predecessorDelegationId: fact.predecessorDelegationId }
          : {}),
        agentName: fact.agentName,
        inputFingerprint: fact.inputFingerprint,
        budget: structuredClone(fact.inheritedPolicy.budget),
        permissions: structuredClone(fact.inheritedPolicy.permissions),
        model: structuredClone(fact.model),
        workspace: structuredClone(fact.workspace),
        status: "recorded",
      });
      continue;
    }
    if (
      !existing ||
      existing.childRunId !== fact.childRunId ||
      existing.inputFingerprint !== fact.inputFingerprint
    ) {
      throw new CoreMindError("run_state_corrupt", "Child Run 生命周期缺少匹配的 Delegation Fact");
    }
    if (fact.type === "delegation_disposition_recorded") {
      if (
        existing.status !== "joined" ||
        !existing.result ||
        !childRunResultRequiresDisposition(existing.result) ||
        existing.disposition?.state !== "required" ||
        childRunResultFingerprint(existing.result) !== fact.resultFingerprint ||
        canonicalRecovery(existing.result) !== canonicalJson(fact.recovery) ||
        delegationDispositionViolation(existing.result, fact.action, fact.decidedBy) !== undefined
      ) {
        throw new CoreMindError(
          "run_state_corrupt",
          "Delegation Disposition 与已 join 的 Child Run 结果不匹配",
        );
      }
      existing.disposition = {
        state: fact.action === "redelegate" ? "awaiting_redelegation" : "recorded",
        action: fact.action,
        decidedBy: fact.decidedBy,
        reason: fact.reason,
        recoveryDisposition: fact.recovery.recoveryDisposition,
      };
      continue;
    }
    if (fact.type === "delegation_redelegation_cancelled") {
      if (
        existing.status !== "joined" ||
        existing.disposition?.state !== "awaiting_redelegation" ||
        existing.disposition.action !== "redelegate" ||
        existing.disposition.successorDelegationId !== undefined
      ) {
        throw new CoreMindError(
          "run_state_corrupt",
          "重新委派撤销 Fact 与待建立 successor 的处置不匹配",
        );
      }
      existing.disposition.state = "redelegation_cancelled";
      existing.disposition.parentTerminalCode = fact.parentTerminalCode;
      existing.disposition.cancellationReason = fact.reason;
      continue;
    }
    existing.status = foldChildRunLifecycleStatus(existing.status, fact.type);
    if (fact.type === "child_terminal") {
      existing.outcome = structuredClone(fact.result.outcome);
      existing.result = structuredClone(fact.result);
    }
    if (fact.type === "child_paused") {
      existing.outcome = structuredClone(fact.result.outcome);
      existing.result = structuredClone(fact.result);
    }
    if (fact.type === "child_orphaned") {
      existing.outcome = structuredClone(fact.result.outcome);
      existing.result = structuredClone(fact.result);
    }
    if (fact.type === "parent_joined") {
      existing.outcome = structuredClone(fact.result.outcome);
      existing.result = structuredClone(fact.result);
      const recovery = childRunRecoveryAssessment(fact.result);
      existing.disposition = !childRunResultRequiresDisposition(fact.result)
        ? { state: "not_required", recoveryDisposition: recovery.recoveryDisposition }
        : {
            state: "required",
            requiredActor: isChildRunRecoverySafeForRedelegation(recovery)
              ? "parent_agent"
              : "human",
            recoveryDisposition: recovery.recoveryDisposition,
          };
    }
  }
  if (nodes.size === 0) return undefined;
  const projected = [...nodes.values()];
  const activeDescendants = projected.filter(
    (node) => node.status === "created" || node.status === "running",
  ).length;
  const unhandledDescendants = projected.filter(childRunNodeIsUnhandled).length;
  return {
    nodes: structuredClone(projected),
    activeDescendants,
    unhandledDescendants,
    quiescent: unhandledDescendants === 0,
  };
}

function childRunNodeIsUnhandled(node: ChildRunNodeProjection): boolean {
  return (
    node.status !== "joined" ||
    node.disposition?.state === "required" ||
    node.disposition?.state === "awaiting_redelegation"
  );
}

function canonicalRecovery(result: ChildRunResult): string {
  return canonicalJson(childRunRecoveryAssessment(result));
}

function projectSnapshot(input: {
  runId: string;
  operation?: DurableOperationSnapshot;
  outcome?: RunOutcome;
  metrics?: RunMetrics;
  evaluation?: EvaluationReport;
  releaseReadiness?: ReleaseReadiness;
  trace: CoreMindTraceEvent[];
  checkpoints: CheckpointRecord[];
  artifacts?: ArtifactRecord[];
  extensions: LifecycleExtensionReceipt[];
}): RunSnapshot | undefined {
  const { operation, outcome, metrics, evaluation, releaseReadiness } = input;
  if (!operation || !outcome || !metrics || !evaluation || !releaseReadiness || !input.artifacts) {
    return undefined;
  }
  return createRunSnapshot({
    runId: input.runId,
    operation,
    outcome,
    metrics,
    evaluation,
    releaseReadiness,
    trace: input.trace,
    checkpoints: input.checkpoints,
    artifacts: input.artifacts,
    extensions: input.extensions,
  });
}

function projectCheckpoints(records: readonly RunStateRecord[], runId: string): CheckpointRecord[] {
  const checkpoints = new Map<string, CheckpointRecord>();
  for (const record of records) {
    if (record.kind !== "checkpoint") continue;
    if (!isRecord(record.payload)) {
      throw new CoreMindError("run_state_corrupt", "Run Fact 包含损坏的 checkpoint payload");
    }
    const checkpoint = record.payload;
    if (
      checkpoint.version !== 1 ||
      checkpoint.runId !== runId ||
      typeof checkpoint.checkpointId !== "string" ||
      typeof checkpoint.timestamp !== "string" ||
      Number.isNaN(Date.parse(checkpoint.timestamp)) ||
      typeof checkpoint.tool !== "string" ||
      typeof checkpoint.reversible !== "boolean" ||
      typeof checkpoint.snapshotFile !== "string" ||
      !optionalString(checkpoint.operationId) ||
      !optionalString(checkpoint.toolCallId) ||
      !optionalString(checkpoint.idempotencyKey) ||
      !optionalString(checkpoint.targetPath) ||
      !optionalBoolean(checkpoint.existed) ||
      !optionalString(checkpoint.beforeSha256) ||
      !optionalBoolean(checkpoint.afterExisted) ||
      !optionalString(checkpoint.afterSha256) ||
      !optionalString(checkpoint.reason)
    ) {
      throw new CoreMindError("run_state_corrupt", "Run Fact 包含损坏的 checkpoint payload");
    }
    const candidate = checkpoint as unknown as CheckpointRecord;
    const previous = checkpoints.get(candidate.checkpointId);
    if (previous && !isCheckpointRefinement(previous, candidate)) {
      throw new CoreMindError(
        "run_state_corrupt",
        `Checkpoint ${candidate.checkpointId} 的写前身份或写后状态发生冲突`,
      );
    }
    checkpoints.set(candidate.checkpointId, candidate);
  }
  return [...checkpoints.values()];
}

function isCheckpointRefinement(previous: CheckpointRecord, candidate: CheckpointRecord): boolean {
  const immutableFields: ReadonlyArray<keyof CheckpointRecord> = [
    "version",
    "checkpointId",
    "runId",
    "operationId",
    "toolCallId",
    "idempotencyKey",
    "timestamp",
    "tool",
    "reversible",
    "targetPath",
    "existed",
    "beforeSha256",
    "reason",
    "snapshotFile",
  ];
  if (immutableFields.some((field) => previous[field] !== candidate[field])) return false;
  if (previous.afterExisted !== undefined && previous.afterExisted !== candidate.afterExisted) {
    return false;
  }
  return previous.afterSha256 === undefined || previous.afterSha256 === candidate.afterSha256;
}

function projectArtifacts(trace: readonly CoreMindTraceEvent[]): ArtifactProjection[] {
  return trace.flatMap(({ event }) => {
    if (event.type !== "artifact_created") return [];
    return [
      {
        artifactId: event.artifactId,
        status: event.status,
        ...(event.relativePath ? { relativePath: event.relativePath } : {}),
        sizeBytes: event.sizeBytes,
        ...(event.sha256 ? { sha256: event.sha256 } : {}),
        mediaType: event.mediaType,
        redaction: event.redaction,
      },
    ];
  });
}

function asArtifactRecords(value: unknown): ArtifactRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(
    (artifact) =>
      isRecord(artifact) &&
      typeof artifact.artifactId === "string" &&
      (artifact.status === "stored" || artifact.status === "blocked") &&
      (artifact.relativePath === undefined || typeof artifact.relativePath === "string") &&
      isNumber(artifact.sizeBytes) &&
      (artifact.sha256 === undefined || typeof artifact.sha256 === "string") &&
      typeof artifact.mediaType === "string" &&
      isTimestamp(artifact.createdAt) &&
      artifact.retention === "run" &&
      (artifact.redaction === "none" || artifact.redaction === "blocked-secret"),
  )
    ? (value as ArtifactRecord[])
    : undefined;
}

function asExtensionReceipts(value: unknown): LifecycleExtensionReceipt[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every(
    (receipt) =>
      isRecord(receipt) &&
      typeof receipt.extensionId === "string" &&
      typeof receipt.extensionVersion === "string" &&
      LIFECYCLE_EVENTS.includes(receipt.event as never) &&
      (receipt.status === "succeeded" ||
        receipt.status === "failed" ||
        receipt.status === "timed_out") &&
      isNumber(receipt.durationMs) &&
      (receipt.error === undefined || typeof receipt.error === "string") &&
      (receipt.denied === undefined || typeof receipt.denied === "boolean"),
  )
    ? (value as LifecycleExtensionReceipt[])
    : undefined;
}

function projectExtensions(trace: readonly CoreMindTraceEvent[]): LifecycleExtensionReceipt[] {
  return trace.flatMap(({ event }) =>
    event.type === "extension_lifecycle"
      ? [
          {
            extensionId: event.extensionId,
            extensionVersion: event.extensionVersion,
            event: event.lifecycle,
            status: event.status,
            durationMs: event.durationMs,
            ...(event.error ? { error: event.error } : {}),
            ...(event.denied !== undefined ? { denied: event.denied } : {}),
          },
        ]
      : [],
  );
}

function projectPendingApprovals(trace: readonly CoreMindTraceEvent[]): PendingApprovalControl[] {
  const resolved = new Set(
    trace.flatMap(({ event }) => (event.type === "approval_resolved" ? [event.approvalId] : [])),
  );
  return trace.flatMap(({ event }) =>
    event.type === "approval_required" && !resolved.has(event.approvalId)
      ? [
          {
            type: "approval" as const,
            approvalId: event.approvalId,
            runId: event.runId,
            agent: event.agent,
            tool: event.tool,
            risk: event.risk,
          },
        ]
      : [],
  );
}

function projectContext(trace: readonly CoreMindTraceEvent[]): ContextProjection {
  return {
    stablePrefixes: trace.flatMap(({ event }) =>
      event.type === "context_prefix"
        ? [{ agent: event.agent, fingerprint: event.fingerprint }]
        : [],
    ),
    budgets: trace.flatMap(({ event }) =>
      event.type === "context_budget_resolved"
        ? [
            {
              providerId: event.providerId,
              modelId: event.modelId,
              capabilityFingerprint: event.capabilityFingerprint,
              source: event.source,
              confidence: event.confidence,
              effectiveContextWindow: event.effectiveContextWindow,
              reservedOutputTokens: event.reservedOutputTokens,
              availableInputTokens: event.availableInputTokens,
              messageTokens: event.messageTokens,
              estimator: event.estimator,
            },
          ]
        : [],
    ),
    compactions: trace.flatMap(({ event }) =>
      event.type === "context_compacted"
        ? [
            {
              beforeTokens: event.beforeTokens,
              afterTokens: event.afterTokens,
              removedMessages: event.removedMessages,
              strategy: event.strategy,
              reason: event.reason,
              summaryFingerprint: event.summaryFingerprint,
              ...(event.sessionEntryId ? { sessionEntryId: event.sessionEntryId } : {}),
              ...(event.capabilityFingerprint
                ? { capabilityFingerprint: event.capabilityFingerprint }
                : {}),
              ...(event.lineageDepth === undefined ? {} : { lineageDepth: event.lineageDepth }),
              ...(event.rebuiltFromCanonical === undefined
                ? {}
                : { rebuiltFromCanonical: event.rebuiltFromCanonical }),
              ...(event.trigger ? { trigger: event.trigger } : {}),
            },
          ]
        : [],
    ),
    failures: trace.flatMap(({ event }) =>
      event.type === "context_compaction_failed"
        ? [{ message: event.message, preservedMessages: event.preservedMessages }]
        : [],
    ),
    lifecycleFailures: trace.flatMap(({ event }) =>
      event.type === "context_lifecycle_failed"
        ? [
            {
              code: event.code,
              reason: event.reason,
              pausable: event.pausable,
              preservedMessages: event.preservedMessages,
              providerCallBlocked: event.providerCallBlocked,
            },
          ]
        : [],
    ),
  };
}

function isTraceEvent(value: unknown, runId: string): value is CoreMindTraceEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    value.runId === runId &&
    Number.isInteger(value.sequence) &&
    isTimestamp(value.timestamp) &&
    isRecord(value.event) &&
    typeof value.event.type === "string" &&
    isProjectionEventValid(value.event, runId)
  );
}

function isProjectionEventValid(event: Record<string, unknown>, runId: string): boolean {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
      return (
        typeof event.agent === "string" &&
        optionalString(event.stepId) &&
        optionalString(event.turnId)
      );
    case "turn_end":
      return (
        typeof event.agent === "string" &&
        optionalString(event.stepId) &&
        optionalString(event.turnId) &&
        optionalNumber(event.tokens) &&
        optionalNumber(event.inputTokens) &&
        optionalNumber(event.outputTokens) &&
        optionalNumber(event.cacheReadTokens) &&
        optionalNumber(event.cacheWriteTokens) &&
        (event.promptCacheStatus === undefined ||
          event.promptCacheStatus === "available" ||
          event.promptCacheStatus === "unavailable") &&
        optionalNumber(event.costUsd) &&
        optionalBoolean(event.requestsAnotherTurn)
      );
    case "text_delta":
      return (
        typeof event.agent === "string" &&
        typeof event.delta === "string" &&
        optionalString(event.stepId)
      );
    case "tool_call":
      return (
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        "args" in event &&
        optionalString(event.argumentsFingerprint) &&
        optionalString(event.callId) &&
        optionalString(event.idempotencyKey) &&
        optionalString(event.stepId) &&
        optionalString(event.turnId)
      );
    case "tool_result":
      return (
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        typeof event.isError === "boolean" &&
        optionalString(event.callId) &&
        optionalString(event.idempotencyKey) &&
        optionalString(event.stepId) &&
        optionalString(event.turnId)
      );
    case "tool_attempt":
      return (
        typeof event.attemptId === "string" &&
        typeof event.previousReceiptId === "string" &&
        Number.isInteger(event.attempt) &&
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        typeof event.callId === "string" &&
        optionalString(event.stepId) &&
        typeof event.argumentsFingerprint === "string"
      );
    case "capability_resolved":
      return (
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        typeof event.callId === "string" &&
        optionalString(event.stepId) &&
        isResolvedToolCapability(event.capability, event.tool) &&
        RECOVERY_DISPOSITIONS.includes(event.recoveryDisposition as never) &&
        recoveryDispositionFor(event.capability) === event.recoveryDisposition
      );
    case "workspace_lease":
      return (
        ["acquired", "released", "recovery_required"].includes(String(event.status)) &&
        typeof event.canonicalRoot === "string" &&
        ["parallel", "run_serial", "workspace_exclusive"].includes(String(event.lane)) &&
        isRecord(event.owner) &&
        (event.status === "recovery_required" || event.owner.runId === runId) &&
        typeof event.owner.callId === "string" &&
        Number.isInteger(event.owner.pid) &&
        typeof event.agent === "string" &&
        typeof event.callId === "string" &&
        optionalString(event.stepId)
      );
    case "effect_receipt":
      return (
        typeof event.idempotencyKey === "string" &&
        typeof event.tool === "string" &&
        ["not_started", "started", "committed", "unknown"].includes(String(event.status)) &&
        optionalString(event.agent) &&
        optionalString(event.callId) &&
        optionalString(event.stepId) &&
        optionalString(event.turnId) &&
        (event.binding === undefined || isEffectReceiptBinding(event.binding, event, runId))
      );
    case "step_start":
      return typeof event.stepId === "string" && typeof event.kind === "string";
    case "step_output":
      return (
        typeof event.stepId === "string" &&
        typeof event.agent === "string" &&
        typeof event.text === "string" &&
        optionalString(event.saveAs)
      );
    case "step_resumed":
      return typeof event.stepId === "string";
    case "step_end":
      return typeof event.stepId === "string" && typeof event.ok === "boolean";
    case "loop_state":
      return (
        isLoopPhase(event.from) &&
        isLoopPhase(event.to) &&
        typeof event.trigger === "string" &&
        nonNegativeInteger(event.iteration) &&
        nonNegativeInteger(event.repairs) &&
        optionalString(event.reason)
      );
    case "retry":
      return (
        (event.scope === "provider" || event.scope === "workflow") &&
        Number.isInteger(event.attempt) &&
        (event.attempt as number) >= 1 &&
        optionalString(event.stepId)
      );
    case "artifact_created":
      return (
        typeof event.artifactId === "string" &&
        (event.status === "stored" || event.status === "blocked") &&
        isNumber(event.sizeBytes) &&
        optionalString(event.relativePath) &&
        optionalString(event.sha256) &&
        typeof event.mediaType === "string" &&
        (event.redaction === "none" || event.redaction === "blocked-secret") &&
        typeof event.tool === "string" &&
        optionalString(event.callId)
      );
    case "extension_lifecycle":
      return (
        typeof event.extensionId === "string" &&
        typeof event.extensionVersion === "string" &&
        LIFECYCLE_EVENTS.includes(event.lifecycle as never) &&
        (event.status === "succeeded" ||
          event.status === "failed" ||
          event.status === "timed_out") &&
        isNumber(event.durationMs) &&
        optionalString(event.error) &&
        optionalBoolean(event.denied)
      );
    case "approval_required":
      return (
        typeof event.approvalId === "string" &&
        event.runId === runId &&
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        "args" in event &&
        (event.risk === "low" || event.risk === "high") &&
        isToolEffect(event.effect) &&
        (event.capability === undefined || isResolvedToolCapability(event.capability, event.tool))
      );
    case "approval_resolved":
      return (
        typeof event.approvalId === "string" &&
        event.runId === runId &&
        (event.decision === "allow" || event.decision === "deny")
      );
    case "policy_denied":
      return (
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        typeof event.reason === "string"
      );
    case "budget_exceeded":
      return (
        ["turns", "toolCalls", "toolFailures", "tokens", "costUsd"].includes(
          String(event.dimension),
        ) &&
        isNumber(event.limit) &&
        isNumber(event.actual) &&
        typeof event.message === "string"
      );
    case "context_prefix":
      return typeof event.agent === "string" && typeof event.fingerprint === "string";
    case "provider_request":
      return (
        typeof event.requestId === "string" &&
        typeof event.agent === "string" &&
        optionalString(event.stepId) &&
        typeof event.providerId === "string" &&
        typeof event.modelId === "string" &&
        typeof event.messageFingerprint === "string" &&
        typeof event.stablePrefixFingerprint === "string" &&
        typeof event.toolSchemaFingerprint === "string" &&
        typeof event.capabilityFingerprint === "string" &&
        typeof event.contextWorkingSetFingerprint === "string"
      );
    case "context_budget_resolved":
      return (
        typeof event.providerId === "string" &&
        typeof event.modelId === "string" &&
        typeof event.capabilityFingerprint === "string" &&
        [
          "locked_catalog",
          "explicit_config",
          "provider_metadata",
          "conservative_fallback",
        ].includes(String(event.source)) &&
        ["verified", "declared", "assumed"].includes(String(event.confidence)) &&
        isNumber(event.effectiveContextWindow) &&
        isNumber(event.reservedOutputTokens) &&
        isNumber(event.availableInputTokens) &&
        isNumber(event.messageTokens) &&
        isNumber(event.stablePrefixTokens) &&
        isNumber(event.toolSchemaTokens) &&
        isNumber(event.structuredOutputTokens) &&
        isNumber(event.multimodalTokens) &&
        isNumber(event.protocolOverheadTokens) &&
        isNumber(event.safetyMarginTokens) &&
        event.estimator === "pi-agent-core-estimate-v1" &&
        Array.isArray(event.evidence) &&
        event.evidence.every(
          (item) => item === "safe_context_intersection" || item === "assumed_context_window",
        )
      );
    case "context_compacted":
      return (
        isNumber(event.beforeTokens) &&
        isNumber(event.afterTokens) &&
        isNumber(event.removedMessages) &&
        (event.strategy === "deterministic-v1" || event.strategy === "task-state-v1") &&
        event.reason === "threshold" &&
        typeof event.summaryFingerprint === "string" &&
        optionalString(event.sessionEntryId) &&
        optionalString(event.capabilityFingerprint) &&
        optionalNumber(event.lineageDepth) &&
        optionalBoolean(event.rebuiltFromCanonical) &&
        (event.trigger === undefined ||
          event.trigger === "threshold" ||
          event.trigger === "model_switch" ||
          event.trigger === "provider_overflow")
      );
    case "context_compaction_failed":
      return typeof event.message === "string" && isNumber(event.preservedMessages);
    case "context_lifecycle_failed":
      return (
        [
          "context_capability_conflict",
          "context_budget_exhausted",
          "context_artifact_missing",
          "context_lineage_corrupt",
        ].includes(String(event.code)) &&
        typeof event.reason === "string" &&
        typeof event.pausable === "boolean" &&
        isNumber(event.preservedMessages) &&
        event.providerCallBlocked === true
      );
    case "checkpoint_created":
      return (
        typeof event.checkpointId === "string" &&
        typeof event.tool === "string" &&
        optionalString(event.callId) &&
        optionalString(event.idempotencyKey) &&
        optionalString(event.targetPath) &&
        typeof event.reversible === "boolean"
      );
    case "tool_execution_evidence":
      return (
        typeof event.agent === "string" &&
        typeof event.tool === "string" &&
        typeof event.callId === "string" &&
        optionalString(event.stepId) &&
        isRecord(event.execution) &&
        isNumber(event.execution.durationMs) &&
        (event.execution.exitCode === null || Number.isInteger(event.execution.exitCode)) &&
        optionalString(event.execution.commandSha256) &&
        optionalBoolean(event.execution.testCommand)
      );
    case "engineering_evidence":
      return (
        typeof event.stepId === "string" &&
        typeof event.textPassed === "boolean" &&
        typeof event.passed === "boolean" &&
        nonNegativeInteger(event.successfulTestCommands) &&
        typeof event.regressionCommandMatched === "boolean" &&
        typeof event.checkpointRecorded === "boolean" &&
        typeof event.diffReviewed === "boolean" &&
        Array.isArray(event.reasons) &&
        event.reasons.every((reason) => typeof reason === "string")
      );
    case "error":
      return typeof event.message === "string" && typeof event.fatal === "boolean";
    case "input_receipt":
      return (
        typeof event.inputId === "string" &&
        event.status === "pending" &&
        typeof event.contentFingerprint === "string" &&
        isTimestamp(event.timestamp)
      );
    case "input_claimed":
      return (
        typeof event.inputId === "string" &&
        event.status === "claimed" &&
        typeof event.turnId === "string" &&
        isTimestamp(event.timestamp)
      );
    case "input_completed":
      return (
        typeof event.inputId === "string" &&
        event.status === "completed" &&
        isTimestamp(event.timestamp)
      );
    case "input_discarded":
      return (
        typeof event.inputId === "string" &&
        event.status === "discarded" &&
        isTimestamp(event.timestamp)
      );
    case "quiescence_timeout":
      return isNumber(event.timeoutMs);
    case "tool_lifecycle":
      return isToolLifecycleFact(event);
    default:
      return false;
  }
}

const LOOP_PHASES = new Set([
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

function isLoopPhase(value: unknown): boolean {
  return typeof value === "string" && LOOP_PHASES.has(value);
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isToolEffect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.operations) &&
    value.operations.every((operation) =>
      ["read", "write", "process", "network", "external"].includes(String(operation)),
    ) &&
    Array.isArray(value.paths) &&
    value.paths.every((path) => typeof path === "string") &&
    Array.isArray(value.urls) &&
    value.urls.every((url) => typeof url === "string") &&
    typeof value.reversible === "boolean" &&
    typeof value.declared === "boolean"
  );
}

function isEffectReceiptBinding(
  value: unknown,
  event: Record<string, unknown>,
  runId: string,
): boolean {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.runId === runId &&
    typeof value.turnId === "string" &&
    value.agent === event.agent &&
    optionalString(value.stepId) &&
    value.stepId === event.stepId &&
    value.callId === event.callId &&
    value.tool === event.tool &&
    typeof value.argumentsFingerprint === "string" &&
    value.argumentsFingerprint.length === 64 &&
    typeof value.capabilityFingerprint === "string" &&
    value.capabilityFingerprint.length === 64
  );
}

function isToolLifecycleFact(value: unknown): boolean {
  try {
    validateToolCallLifecycleFact(value);
    return true;
  } catch {
    return false;
  }
}

function terminalField<T>(
  payload: Record<string, unknown> | undefined,
  field: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  if (!payload || !(field in payload)) return undefined;
  const parsed = parse(payload[field]);
  if (parsed === undefined) {
    throw new CoreMindError("run_state_corrupt", `Run Fact 包含损坏的 terminal.${field}`);
  }
  return parsed;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function asOperation(value: unknown, runId: string): DurableOperationSnapshot | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.runId !== runId ||
    typeof value.operationId !== "string" ||
    typeof value.correlationId !== "string" ||
    !["accepted", "running", "paused", "aborting", "completed", "failed"].includes(
      String(value.state),
    ) ||
    !Number.isInteger(value.transitionSequence) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !optionalString(value.pauseReason) ||
    !optionalString(value.failureReason)
  ) {
    return undefined;
  }
  return value as unknown as DurableOperationSnapshot;
}

function asRunOutcome(value: unknown): RunOutcome | undefined {
  return isRecord(value) &&
    ["succeeded", "failed", "paused", "aborted", "timeout", "budget_exceeded"].includes(
      String(value.status),
    ) &&
    typeof value.finishReason === "string" &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string" &&
        (value.error.audit === undefined ||
          (isRecord(value.error.audit) && typeof value.error.audit.originalCode === "string"))))
    ? (value as unknown as RunOutcome)
    : undefined;
}

function asRunMetrics(value: unknown): RunMetrics | undefined {
  return isRecord(value) &&
    isNumber(value.durationMs) &&
    isNumber(value.turns) &&
    isRecord(value.steps) &&
    isNumber(value.steps.total) &&
    isNumber(value.steps.succeeded) &&
    isNumber(value.steps.failed) &&
    isNumber(value.toolCalls) &&
    isNumber(value.toolFailures) &&
    isNumber(value.retries) &&
    optionalNumber(value.tokens) &&
    optionalNumber(value.costUsd) &&
    isNumber(value.outputChars) &&
    (value.context === undefined || isRunContextMetrics(value.context)) &&
    (value.artifacts === undefined || isArtifactMetrics(value.artifacts)) &&
    optionalNumber(value.rejectedAfterAbort)
    ? (value as unknown as RunMetrics)
    : undefined;
}

function isRunContextMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.inputTokens) &&
    isNumber(value.outputTokens) &&
    isNumber(value.cacheReadTokens) &&
    isNumber(value.cacheWriteTokens) &&
    ["available", "unavailable", "unknown"].includes(String(value.promptCacheStatus)) &&
    isNumber(value.compactions) &&
    optionalString(value.lastSummaryFingerprint) &&
    Array.isArray(value.stablePrefixFingerprints) &&
    value.stablePrefixFingerprints.every((item) => typeof item === "string")
  );
}

function isArtifactMetrics(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value.stored) &&
    isNumber(value.blocked) &&
    isNumber(value.totalBytes)
  );
}

function asEvaluationReport(value: unknown): EvaluationReport | undefined {
  return isRecord(value) &&
    ["development", "standard", "strict"].includes(String(value.profile)) &&
    Array.isArray(value.scenarioResults) &&
    value.scenarioResults.every(
      (result) =>
        isRecord(result) &&
        typeof result.id === "string" &&
        typeof result.passed === "boolean" &&
        optionalNumber(result.score) &&
        optionalString(result.reason),
    ) &&
    isRecord(value.qualityScores) &&
    Object.values(value.qualityScores).every(isNumber) &&
    Array.isArray(value.securityFindings) &&
    value.securityFindings.every((finding) => typeof finding === "string")
    ? (value as unknown as EvaluationReport)
    : undefined;
}

function asReleaseReadiness(value: unknown): ReleaseReadiness | undefined {
  return isRecord(value) &&
    typeof value.ready === "boolean" &&
    Array.isArray(value.blockers) &&
    value.blockers.every((blocker) => typeof blocker === "string") &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string") &&
    (value.overrideRecord === undefined ||
      (isRecord(value.overrideRecord) &&
        typeof value.overrideRecord.reason === "string" &&
        isTimestamp(value.overrideRecord.recordedAt)))
    ? (value as unknown as ReleaseReadiness)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
