import type { ArtifactRecord } from "coremind-tools";
import type { CheckpointRecord } from "./checkpoint.js";
import { CoreMindError } from "./errors.js";
import { LIFECYCLE_EVENTS, type LifecycleExtensionReceipt } from "./lifecycle-extension.js";
import type { DurableOperationSnapshot } from "./operation-state.js";
import type { EvaluationReport, ReleaseReadiness, RunMetrics, RunOutcome } from "./result.js";
import {
  isRunStateResumable,
  operationSnapshotFromRecords,
  prepareRunResume,
  type RunResumePlan,
  type RunStateRecord,
} from "./run-state.js";
import { createRunSnapshot, type RunSnapshot } from "./snapshot.js";
import type { CoreMindTraceEvent } from "./trace.js";

export type RunProjectionStatus = "finished" | "paused" | "interrupted";

export interface PendingApprovalControl {
  type: "approval";
  approvalId: string;
  runId: string;
  agent: string;
  tool: string;
  risk: "low" | "high";
}

export interface RecoveryDecision {
  resumable: boolean;
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
  pendingControls: PendingApprovalControl[];
  observability: {
    factCount: number;
    lastSequence: number;
    lastTimestamp: string;
  };
  records: RunStateRecord[];
  snapshot?: RunSnapshot;
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
    const recovery: RecoveryDecision = {
      resumable: isRunStateResumable(ordered),
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
      context: projectContext(trace),
      pendingControls: projectPendingControls(trace),
      observability: {
        factCount: ordered.length,
        lastSequence: ordered.at(-1)!.sequence,
        lastTimestamp: ordered.at(-1)!.timestamp,
      },
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
    const plan = prepareRunResume([...records], configFingerprint, requestedPrompt);
    if (!projection.recovery.resumable) {
      throw new CoreMindError("run_state_corrupt", "Projection 与恢复计划的准入结果不一致");
    }
    return plan;
  },
};

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
  return records.flatMap((record) => {
    if (record.kind !== "checkpoint") return [];
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
    return [checkpoint as unknown as CheckpointRecord];
  });
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

function projectPendingControls(trace: readonly CoreMindTraceEvent[]): PendingApprovalControl[] {
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
        (event.risk === "low" || event.risk === "high")
      );
    case "approval_resolved":
      return (
        typeof event.approvalId === "string" &&
        event.runId === runId &&
        (event.decision === "allow" || event.decision === "deny")
      );
    case "context_prefix":
      return typeof event.agent === "string" && typeof event.fingerprint === "string";
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
    default:
      return true;
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
        typeof value.error.message === "string"))
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
