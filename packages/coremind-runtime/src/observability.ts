import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { canonicalJson } from "./canonical-json.js";
import { CoreMindError } from "./errors.js";
import type { RunProjectionStatus } from "./projection.js";
import type { RunStateKind, RunStateRecord } from "./run-state.js";
import { projectToolCallLifecycles, type ToolCallLifecycleState } from "./tool-call-lifecycle.js";
import { redactSensitiveValue } from "./trace.js";

export type TelemetryMode = "DISABLED" | "FEEDBACK_ONLY" | "FULL";
export type TelemetryContentLevel = "metrics_only" | "content";
export type TelemetryConfigurationSource = "default" | "configured" | "legacy_default";

export interface TelemetryPolicy {
  mode: TelemetryMode;
  endpoint?: string;
  contentLevel?: TelemetryContentLevel;
  allowedFields?: string[];
}

export interface TelemetryConfigurationFact {
  schemaVersion: 1;
  mode: TelemetryMode;
  contentLevel: TelemetryContentLevel;
  allowedFields: string[];
  configuredAt: string;
  endpointOrigin?: string;
}

export interface TelemetryConsentFact {
  schemaVersion: 1;
  scopeFingerprint: string;
  runId: string;
  consentId: string;
  kind: "feedback" | "content";
  targetOrigin: string;
  contentLevel: TelemetryContentLevel;
  allowedFields: string[];
  throughSequence?: number;
  factPrefixFingerprint?: string;
  retentionPurpose?: string;
  revocationMethod?: string;
  grantedAt: string;
}

export type TelemetryConsentInput = Omit<
  TelemetryConsentFact,
  "schemaVersion" | "scopeFingerprint"
>;

export interface TelemetryAuthorizationScope {
  runId: string;
  consentId: string;
  scopeFingerprint: string;
  kind: TelemetryConsentFact["kind"];
  targetOrigin: string;
  contentLevel: TelemetryContentLevel;
  allowedFields: string[];
  throughSequence?: number;
  factPrefixFingerprint?: string;
  retentionPurpose?: string;
  revocationMethod?: string;
  grantedAt: string;
}

/** 创建与授权范围精确绑定的持久 consent Fact。 */
export function createTelemetryConsentFact(input: TelemetryConsentInput): TelemetryConsentFact {
  const fact: TelemetryConsentFact = {
    schemaVersion: 1,
    scopeFingerprint: telemetryConsentScopeFingerprint(input),
    runId: input.runId,
    consentId: input.consentId,
    kind: input.kind,
    targetOrigin: input.targetOrigin,
    contentLevel: input.contentLevel,
    allowedFields: [...new Set(input.allowedFields)].sort(),
    ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
    ...(input.factPrefixFingerprint === undefined
      ? {}
      : { factPrefixFingerprint: input.factPrefixFingerprint }),
    ...(input.retentionPurpose === undefined ? {} : { retentionPurpose: input.retentionPurpose }),
    ...(input.revocationMethod === undefined ? {} : { revocationMethod: input.revocationMethod }),
    grantedAt: input.grantedAt,
  };
  return validateTelemetryConsentFact(fact);
}

/** consent 只绑定发送范围，不把 UI 状态或授权时间混入范围身份。 */
export function telemetryConsentScopeFingerprint(
  input: Pick<
    TelemetryConsentFact,
    | "runId"
    | "kind"
    | "targetOrigin"
    | "contentLevel"
    | "allowedFields"
    | "throughSequence"
    | "factPrefixFingerprint"
    | "retentionPurpose"
    | "revocationMethod"
  >,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        runId: input.runId,
        kind: input.kind,
        targetOrigin: input.targetOrigin,
        contentLevel: input.contentLevel,
        allowedFields: [...new Set(input.allowedFields)].sort(),
        ...(input.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
        ...(input.factPrefixFingerprint === undefined
          ? {}
          : { factPrefixFingerprint: input.factPrefixFingerprint }),
        ...(input.retentionPurpose === undefined
          ? {}
          : { retentionPurpose: input.retentionPurpose }),
        ...(input.revocationMethod === undefined
          ? {}
          : { revocationMethod: input.revocationMethod }),
      }),
      "utf8",
    )
    .digest("hex");
}

export interface TelemetryExportRecord {
  identity: string;
  runId: string;
  sequence: number;
  timestamp: string;
  kind: RunStateKind;
  eventType?: string;
  fields: Readonly<Record<string, unknown>>;
}

export interface TelemetryExporter {
  export(
    record: TelemetryExportRecord,
    context: { authorization: TelemetryEgressAuthorization; signal: AbortSignal },
  ): void | Promise<void>;
  shutdown?(context: { signal: AbortSignal }): void | Promise<void>;
}

export interface TelemetryEgressAuthorization {
  schemaVersion: 1;
  targetOrigin: string;
  resolvedAddresses: string[];
  redirectPolicy: "deny";
  proxyPolicy: "deny";
  tlsPolicy: "strict";
  policyFingerprint: string;
}

export type TelemetryFailureCode =
  | "dns"
  | "tls"
  | "http_401"
  | "http_429"
  | "timeout"
  | "exporter_failed"
  | "exporter_unavailable"
  | "egress_policy_missing"
  | "egress_policy_denied"
  | "configuration_mismatch"
  | "feedback_consent_missing"
  | "content_consent_missing"
  | "redaction_failed";

export class TelemetryExporterError extends Error {
  constructor(
    readonly code: TelemetryFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "TelemetryExporterError";
  }
}

export interface TelemetryDeliveryProjection {
  mode: TelemetryMode;
  exporterLoaded: boolean;
  endpointOrigin?: string;
  contentLevel: TelemetryContentLevel;
  allowedFields: string[];
  queued: number;
  handedOff: number;
  failed: number;
  dropped: number;
  duplicates: number;
  shutdownTimedOut: boolean;
  lastFailure?: TelemetryFailureCode;
}

export interface TelemetryEgressControllerOptions {
  policy: TelemetryPolicy;
  createExporter?: (context: {
    endpointOrigin: string;
    authorization: TelemetryEgressAuthorization;
    signal: AbortSignal;
    credentials?: Readonly<Record<string, string>>;
  }) => TelemetryExporter | Promise<TelemetryExporter>;
  authorizeEgress?: (context: {
    endpointOrigin: string;
    signal: AbortSignal;
  }) => TelemetryEgressAuthorization | Promise<TelemetryEgressAuthorization>;
  readCredentials?: (signal: AbortSignal) => Promise<Record<string, string>>;
  queueLimit?: number;
  exportTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  redact?: (value: unknown) => unknown;
}

/**
 * 可丢弃的 Telemetry 投影器。它只消费已经持久化的 Facts，且永远不写回运行事实。
 */
export class TelemetryEgressController {
  constructor(private readonly options: TelemetryEgressControllerOptions) {}

  async export(records: readonly RunStateRecord[]): Promise<TelemetryDeliveryProjection> {
    const policy = normalizePolicy(this.options.policy);
    const projection = emptyDelivery(policy);
    if (policy.mode === "DISABLED") return projection;

    let endpointOrigin: string;
    try {
      endpointOrigin = endpointOriginOf(policy.endpoint);
    } catch (error) {
      projection.failed = 1;
      projection.lastFailure = failureCodeOf(error);
      return projection;
    }
    projection.endpointOrigin = endpointOrigin;
    let persistedPolicy: ReturnType<typeof telemetryStateFromFacts>;
    try {
      persistedPolicy = telemetryStateFromFacts(canonicalAuthorizationRecords(records));
    } catch {
      projection.failed = 1;
      projection.lastFailure = "configuration_mismatch";
      return projection;
    }
    if (!telemetryConfigurationMatches(persistedPolicy, policy, endpointOrigin)) {
      projection.failed = 1;
      projection.lastFailure = "configuration_mismatch";
      return projection;
    }
    const consentFailure = consentFailureFor(records, policy, endpointOrigin);
    if (consentFailure) {
      projection.failed = 1;
      projection.lastFailure = consentFailure;
      return projection;
    }
    if (!this.options.createExporter) {
      projection.failed = 1;
      projection.lastFailure = "exporter_unavailable";
      return projection;
    }
    if (!this.options.authorizeEgress) {
      projection.failed = 1;
      projection.lastFailure = "egress_policy_missing";
      return projection;
    }

    const exportDeadline = Date.now() + Math.max(0, this.options.exportTimeoutMs ?? 5_000);
    const authorizationResult = await invokeBeforeDeadline(
      (signal) => this.options.authorizeEgress!({ endpointOrigin, signal }),
      exportDeadline,
    );
    if (authorizationResult.status !== "fulfilled") {
      projection.failed = 1;
      projection.lastFailure =
        authorizationResult.status === "timed_out"
          ? "timeout"
          : failureCodeOf(authorizationResult.reason);
      return projection;
    }
    let authorization: TelemetryEgressAuthorization;
    try {
      authorization = validateTelemetryEgressAuthorization(
        authorizationResult.value,
        endpointOrigin,
      );
    } catch {
      projection.failed = 1;
      projection.lastFailure = "egress_policy_denied";
      return projection;
    }

    let exporter: TelemetryExporter;
    try {
      const credentialsResult = this.options.readCredentials
        ? await invokeBeforeDeadline(
            (signal) => this.options.readCredentials!(signal),
            exportDeadline,
          )
        : ({ status: "fulfilled", value: undefined } as const);
      if (credentialsResult.status !== "fulfilled") {
        projection.failed = 1;
        projection.lastFailure =
          credentialsResult.status === "timed_out"
            ? "timeout"
            : failureCodeOf(credentialsResult.reason);
        return projection;
      }
      const exporterResult = await invokeBeforeDeadline(
        (signal) =>
          this.options.createExporter!({
            endpointOrigin,
            authorization,
            signal,
            ...(credentialsResult.value ? { credentials: credentialsResult.value } : {}),
          }),
        exportDeadline,
      );
      if (exporterResult.status !== "fulfilled") {
        projection.failed = 1;
        projection.lastFailure =
          exporterResult.status === "timed_out" ? "timeout" : failureCodeOf(exporterResult.reason);
        return projection;
      }
      exporter = exporterResult.value;
      projection.exporterLoaded = true;
    } catch (error) {
      projection.failed = 1;
      projection.lastFailure = failureCodeOf(error);
      return projection;
    }

    const eligible = eligibleRecords(records, policy, endpointOrigin);
    const unique: RunStateRecord[] = [];
    const identities = new Set<string>();
    for (const record of eligible) {
      const identity = identityOf(record);
      if (identities.has(identity)) {
        projection.duplicates += 1;
        continue;
      }
      identities.add(identity);
      unique.push(record);
    }
    const queueLimit = Math.max(0, this.options.queueLimit ?? Number.POSITIVE_INFINITY);
    const queue = unique.slice(0, queueLimit);
    projection.dropped += unique.length - queue.length;
    projection.queued = queue.length;

    for (const [index, record] of queue.entries()) {
      try {
        const projected = projectExportRecord(record, policy, this.options.redact);
        const exported = await invokeBeforeDeadline(
          (signal) => exporter.export(projected, { authorization, signal }),
          exportDeadline,
        );
        if (exported.status === "timed_out") {
          projection.failed += 1;
          projection.lastFailure = "timeout";
          projection.dropped += queue.length - index - 1;
          projection.queued = 0;
          break;
        }
        if (exported.status === "rejected") throw exported.reason;
        projection.handedOff += 1;
      } catch (error) {
        projection.failed += 1;
        projection.lastFailure = failureCodeOf(error);
      } finally {
        if (projection.queued > 0) projection.queued -= 1;
      }
    }

    if (exporter.shutdown) {
      const shutdown = await invokeWithin(
        (signal) => exporter.shutdown!({ signal }),
        this.options.shutdownTimeoutMs ?? 5_000,
      );
      if (shutdown.status === "timed_out") {
        projection.shutdownTimedOut = true;
        projection.failed += 1;
        projection.lastFailure = "timeout";
      } else if (shutdown.status === "rejected") {
        projection.failed += 1;
        projection.lastFailure = failureCodeOf(shutdown.reason);
      }
    }
    return projection;
  }
}

function telemetryConfigurationMatches(
  persisted: ReturnType<typeof telemetryStateFromFacts>,
  policy: ReturnType<typeof normalizePolicy>,
  endpointOrigin: string,
): boolean {
  return (
    persisted.mode === policy.mode &&
    persisted.endpointOrigin === endpointOrigin &&
    persisted.contentLevel === policy.contentLevel &&
    persisted.allowedFields.length === policy.allowedFields.length &&
    persisted.allowedFields.every((field, index) => field === policy.allowedFields[index])
  );
}

/** 写入 Run start 的安全配置快照：只保留 endpoint origin，不落 query 或凭据。 */
export function createTelemetryConfigurationFact(
  policy: TelemetryPolicy,
  configuredAt: string,
): TelemetryConfigurationFact {
  const normalized = normalizePolicy(policy);
  return validateTelemetryConfigurationFact({
    schemaVersion: 1,
    mode: normalized.mode,
    contentLevel: normalized.contentLevel,
    allowedFields: normalized.allowedFields,
    configuredAt,
    ...(normalized.endpoint ? { endpointOrigin: endpointOriginOf(normalized.endpoint) } : {}),
  });
}

export interface LocalObservabilityProjection {
  schemaVersion: 1;
  localEnabled: true;
  derivedFromSequence: number;
  run: {
    status: RunProjectionStatus;
    resumable: boolean;
    operationState?: string;
    durationMs?: number;
  };
  turns: { started: number; completed: number; active: number };
  calls: {
    started: number;
    completed: number;
    failed: number;
    active: number;
    durationMs: number;
  };
  tools: ToolCallLifecycleState[];
  errors: Array<{ sequence: number; message: string; fatal: boolean }>;
  context: { budgets: number; compactions: number; failures: number };
  artifacts: { stored: number; blocked: number };
  sharedState: { pendingControls: number };
  recovery: { resumable: boolean; operationState?: string };
  telemetry: TelemetryDeliveryProjection & {
    source: TelemetryConfigurationSource;
    deliverySemantics: "best_effort_handoff_not_delivery";
    authorizedScopes: TelemetryAuthorizationScope[];
  };
}

export interface ProjectLocalObservabilityOptions {
  runStatus?: RunProjectionStatus;
  resumable?: boolean;
  operationState?: string;
  context?: { budgets: number; compactions: number; failures: number };
  artifacts?: { stored: number; blocked: number };
  pendingControls?: number;
  telemetryDelivery?: TelemetryDeliveryProjection;
}

/** 从 canonical Run Facts 重建默认开启的本地观测视图。 */
export function projectLocalObservability(
  records: readonly RunStateRecord[],
  options: ProjectLocalObservabilityOptions = {},
): LocalObservabilityProjection {
  const ordered = orderedFacts(records);
  const events = ordered.flatMap((record) => {
    if (record.kind !== "event" || !isRecord(record.payload)) return [];
    const event = record.payload.event;
    return isRecord(event) && typeof event.type === "string"
      ? [{ sequence: record.sequence, event }]
      : [];
  });
  const startedTurns = events.filter(({ event }) => event.type === "agent_start").length;
  const completedTurns = events.filter(({ event }) => event.type === "turn_end").length;
  const startedCalls = events.filter(({ event }) => event.type === "tool_call").length;
  const callResults = events.filter(({ event }) => event.type === "tool_result");
  const telemetry = telemetryStateFromFacts(ordered);
  const delivery = options.telemetryDelivery ?? emptyDelivery(telemetry);
  const runDurationMs = terminalDurationMs(ordered);
  const callDurationMs = events.reduce((total, { event }) => {
    if (event.type !== "tool_execution_evidence" || !isRecord(event.execution)) return total;
    const durationMs = event.execution.durationMs;
    return typeof durationMs === "number" && durationMs >= 0 ? total + durationMs : total;
  }, 0);
  const tools = projectToolCallLifecycles(
    events.flatMap(({ event }) => (event.type === "tool_lifecycle" ? [event] : [])),
  );
  const authorizedScopes = ordered.flatMap((record) => {
    if (record.kind !== "telemetry_consent") return [];
    const consent = validateTelemetryConsentForRecords(record.payload, record, ordered);
    return [
      {
        runId: consent.runId,
        consentId: consent.consentId,
        scopeFingerprint: consent.scopeFingerprint,
        kind: consent.kind,
        targetOrigin: consent.targetOrigin,
        contentLevel: consent.contentLevel,
        allowedFields: [...new Set(consent.allowedFields)].sort(),
        ...(consent.throughSequence === undefined
          ? {}
          : { throughSequence: consent.throughSequence }),
        ...(consent.factPrefixFingerprint === undefined
          ? {}
          : { factPrefixFingerprint: consent.factPrefixFingerprint }),
        ...(consent.retentionPurpose === undefined
          ? {}
          : { retentionPurpose: consent.retentionPurpose }),
        ...(consent.revocationMethod === undefined
          ? {}
          : { revocationMethod: consent.revocationMethod }),
        grantedAt: consent.grantedAt,
      } satisfies TelemetryAuthorizationScope,
    ];
  });

  return {
    schemaVersion: 1,
    localEnabled: true,
    derivedFromSequence: ordered.at(-1)?.sequence ?? 0,
    run: {
      status: options.runStatus ?? statusFromFacts(ordered),
      resumable: options.resumable ?? false,
      ...(options.operationState ? { operationState: options.operationState } : {}),
      ...(runDurationMs === undefined ? {} : { durationMs: runDurationMs }),
    },
    turns: {
      started: startedTurns,
      completed: completedTurns,
      active: Math.max(0, startedTurns - completedTurns),
    },
    calls: {
      started: startedCalls,
      completed: callResults.length,
      failed: callResults.filter(({ event }) => event.isError === true).length,
      active: Math.max(0, startedCalls - callResults.length),
      durationMs: callDurationMs,
    },
    tools,
    errors: events.flatMap(({ sequence, event }) =>
      event.type === "error" &&
      typeof event.message === "string" &&
      typeof event.fatal === "boolean"
        ? [{ sequence, message: event.message, fatal: event.fatal }]
        : [],
    ),
    context: options.context ?? {
      budgets: events.filter(({ event }) => event.type === "context_budget_resolved").length,
      compactions: events.filter(({ event }) => event.type === "context_compacted").length,
      failures: events.filter(
        ({ event }) =>
          event.type === "context_compaction_failed" || event.type === "context_lifecycle_failed",
      ).length,
    },
    artifacts: options.artifacts ?? {
      stored: events.filter(
        ({ event }) => event.type === "artifact_created" && event.status === "stored",
      ).length,
      blocked: events.filter(
        ({ event }) => event.type === "artifact_created" && event.status === "blocked",
      ).length,
    },
    sharedState: { pendingControls: options.pendingControls ?? 0 },
    recovery: {
      resumable: options.resumable ?? false,
      ...(options.operationState ? { operationState: options.operationState } : {}),
    },
    telemetry: {
      ...delivery,
      mode: telemetry.mode,
      contentLevel: telemetry.contentLevel,
      allowedFields: telemetry.allowedFields,
      ...(telemetry.endpointOrigin ? { endpointOrigin: telemetry.endpointOrigin } : {}),
      source: telemetry.source,
      deliverySemantics: "best_effort_handoff_not_delivery",
      authorizedScopes,
    },
  };
}

function terminalDurationMs(records: readonly RunStateRecord[]): number | undefined {
  const terminal = [...records]
    .reverse()
    .find((record) => record.kind === "finish" || record.kind === "pause");
  if (!terminal || !isRecord(terminal.payload) || !isRecord(terminal.payload.metrics)) {
    return undefined;
  }
  const durationMs = terminal.payload.metrics.durationMs;
  return typeof durationMs === "number" && durationMs >= 0 ? durationMs : undefined;
}

function normalizePolicy(
  policy: TelemetryPolicy,
): Required<Pick<TelemetryPolicy, "mode" | "contentLevel" | "allowedFields">> &
  Pick<TelemetryPolicy, "endpoint"> {
  if (!(["DISABLED", "FEEDBACK_ONLY", "FULL"] as const).includes(policy.mode)) {
    throw new CoreMindError("run_state_corrupt", `未知 Telemetry mode：${String(policy.mode)}`);
  }
  const contentLevel = policy.contentLevel ?? "metrics_only";
  if (contentLevel !== "metrics_only" && contentLevel !== "content") {
    throw new CoreMindError("run_state_corrupt", `未知 Telemetry content level：${contentLevel}`);
  }
  return {
    mode: policy.mode,
    contentLevel,
    allowedFields: [...new Set(policy.allowedFields ?? [])].sort(),
    ...(policy.endpoint ? { endpoint: policy.endpoint } : {}),
  };
}

function emptyDelivery(policy: {
  mode: TelemetryMode;
  contentLevel?: TelemetryContentLevel;
  allowedFields?: string[];
  endpointOrigin?: string;
}): TelemetryDeliveryProjection {
  return {
    mode: policy.mode,
    exporterLoaded: false,
    ...(policy.endpointOrigin ? { endpointOrigin: policy.endpointOrigin } : {}),
    contentLevel: policy.contentLevel ?? "metrics_only",
    allowedFields: [...(policy.allowedFields ?? [])],
    queued: 0,
    handedOff: 0,
    failed: 0,
    dropped: 0,
    duplicates: 0,
    shutdownTimedOut: false,
  };
}

function telemetryStateFromFacts(records: readonly RunStateRecord[]): {
  mode: TelemetryMode;
  contentLevel: TelemetryContentLevel;
  allowedFields: string[];
  source: TelemetryConfigurationSource;
  effectiveFromSequence: number;
  endpointOrigin?: string;
} {
  const changed = [...records]
    .reverse()
    .find((record) => record.kind === "telemetry_configuration");
  if (changed) {
    const policy = validateTelemetryConfigurationFact(changed.payload);
    return {
      ...policy,
      source: "configured",
      effectiveFromSequence: changed.sequence,
    };
  }
  const start = records.find((record) => record.kind === "start");
  if (!start || !isRecord(start.payload) || !("telemetry" in start.payload)) {
    return {
      mode: "DISABLED",
      contentLevel: "metrics_only",
      allowedFields: [],
      source: "legacy_default",
      effectiveFromSequence: 1,
    };
  }
  const policy = validateTelemetryConfigurationFact(start.payload.telemetry);
  return {
    ...policy,
    source: policy.mode === "DISABLED" ? "default" : "configured",
    effectiveFromSequence: start.sequence,
  };
}

function consentFailureFor(
  records: readonly RunStateRecord[],
  policy: ReturnType<typeof normalizePolicy>,
  endpointOrigin: string,
): TelemetryFailureCode | undefined {
  const canonical = canonicalAuthorizationRecords(records);
  const consents = canonical.flatMap((record) => {
    if (record.kind !== "telemetry_consent") return [];
    try {
      return [validateTelemetryConsentForRecords(record.payload, record, canonical)];
    } catch {
      return [];
    }
  });
  if (
    policy.mode === "FEEDBACK_ONLY" &&
    !consents.some(
      (consent) =>
        consent.kind === "feedback" &&
        consent.targetOrigin === endpointOrigin &&
        consent.contentLevel === policy.contentLevel &&
        Number.isInteger(consent.throughSequence),
    )
  ) {
    return "feedback_consent_missing";
  }
  if (
    policy.contentLevel === "content" &&
    !consents.some(
      (consent) =>
        consent.kind === "content" &&
        consent.targetOrigin === endpointOrigin &&
        consent.contentLevel === "content" &&
        policy.allowedFields.every((field) => consent.allowedFields.includes(field)),
    )
  ) {
    return "content_consent_missing";
  }
  return undefined;
}

function eligibleRecords(
  records: readonly RunStateRecord[],
  policy: ReturnType<typeof normalizePolicy>,
  endpointOrigin: string,
): RunStateRecord[] {
  const source = records.filter(
    (record) => record.kind !== "telemetry_consent" && record.kind !== "telemetry_configuration",
  );
  if (policy.mode === "FULL") {
    const effectiveFromSequence = telemetryStateFromFacts(
      canonicalAuthorizationRecords(records),
    ).effectiveFromSequence;
    return source.filter((record) => record.sequence >= effectiveFromSequence);
  }
  const canonical = canonicalAuthorizationRecords(records);
  const throughSequence = records
    .flatMap((record) => {
      if (record.kind !== "telemetry_consent") return [];
      try {
        return [validateTelemetryConsentForRecords(record.payload, record, canonical)];
      } catch {
        return [];
      }
    })
    .filter(
      (consent) =>
        consent.kind === "feedback" &&
        consent.targetOrigin === endpointOrigin &&
        consent.contentLevel === policy.contentLevel,
    )
    .reduce((highest, consent) => Math.max(highest, consent.throughSequence ?? 0), 0);
  return source.filter((record) => record.sequence <= throughSequence);
}

function projectExportRecord(
  record: RunStateRecord,
  policy: ReturnType<typeof normalizePolicy>,
  redact: ((value: unknown) => unknown) | undefined,
): TelemetryExportRecord {
  const event = traceEventOf(record);
  const fields: Record<string, unknown> = metricsFields(record, event);
  if (policy.contentLevel === "content") {
    for (const field of policy.allowedFields) {
      const value = contentField(record, event, field);
      if (value !== undefined) fields[field] = value;
    }
  }
  try {
    const redacted = (redact ?? ((value) => redactSensitiveValue(value, { redactBodies: false })))(
      fields,
    );
    if (!isRecord(redacted)) throw new Error("脱敏器没有返回对象");
    return {
      identity: identityOf(record),
      runId: record.runId,
      sequence: record.sequence,
      timestamp: record.timestamp,
      kind: record.kind,
      ...(event ? { eventType: String(event.type) } : {}),
      fields: redacted,
    };
  } catch (error) {
    throw new TelemetryExporterError(
      "redaction_failed",
      `Telemetry 脱敏失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function metricsFields(
  record: RunStateRecord,
  event: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (event) {
    for (const key of [
      "status",
      "fatal",
      "isError",
      "durationMs",
      "tokens",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "beforeTokens",
      "afterTokens",
      "removedMessages",
      "sizeBytes",
      "attempt",
    ]) {
      const value = event[key];
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        fields[key] = value;
      }
    }
  }
  if ((record.kind === "pause" || record.kind === "finish") && isRecord(record.payload)) {
    const outcome = record.payload.outcome;
    if (isRecord(outcome) && typeof outcome.status === "string")
      fields.outcomeStatus = outcome.status;
    const metrics = record.payload.metrics;
    if (isRecord(metrics) && typeof metrics.durationMs === "number") {
      fields.durationMs = metrics.durationMs;
    }
  }
  return fields;
}

function contentField(
  record: RunStateRecord,
  event: Record<string, unknown> | undefined,
  field: string,
): unknown {
  if (field.startsWith("start.") && record.kind === "start" && isRecord(record.payload)) {
    return valueAtPath(record.payload, field.slice("start.".length));
  }
  if (!event || !field.startsWith("event.")) return undefined;
  const [, eventType, ...path] = field.split(".");
  return event.type === eventType ? valueAtPath(event, path.join(".")) : undefined;
}

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function orderedFacts(records: readonly RunStateRecord[]): RunStateRecord[] {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence);
  const runId = ordered[0]?.runId;
  for (const [index, record] of ordered.entries()) {
    if (record.runId !== runId || record.sequence !== index + 1) {
      throw new CoreMindError("run_state_corrupt", "Run Facts 身份或 sequence 不连续");
    }
  }
  return ordered;
}

function statusFromFacts(records: readonly RunStateRecord[]): RunProjectionStatus {
  const terminal = [...records]
    .reverse()
    .find((record) => record.kind === "finish" || record.kind === "pause");
  return terminal?.kind === "finish"
    ? "finished"
    : terminal?.kind === "pause"
      ? "paused"
      : "interrupted";
}

function endpointOriginOf(endpoint: string | undefined): string {
  if (!endpoint)
    throw new TelemetryExporterError("exporter_unavailable", "Telemetry endpoint 未配置");
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      throw new Error("协议不受支持");
    return parsed.origin;
  } catch (error) {
    throw new TelemetryExporterError(
      "exporter_unavailable",
      `Telemetry endpoint 无效：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function identityOf(record: RunStateRecord): string {
  return `${record.runId}:${record.sequence}:${record.eventId ?? record.kind}`;
}

function traceEventOf(record: RunStateRecord): Record<string, unknown> | undefined {
  if (record.kind !== "event" || !isRecord(record.payload) || !isRecord(record.payload.event)) {
    return undefined;
  }
  return record.payload.event;
}

export function isTelemetryConsentFact(value: unknown): value is TelemetryConsentFact {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.scopeFingerprint === "string" &&
    isNonBlankString(value.runId) &&
    isNonBlankString(value.consentId) &&
    (value.kind === "feedback" || value.kind === "content") &&
    typeof value.targetOrigin === "string" &&
    isEndpointOrigin(value.targetOrigin) &&
    (value.contentLevel === "metrics_only" || value.contentLevel === "content") &&
    Array.isArray(value.allowedFields) &&
    isCanonicalStringList(value.allowedFields) &&
    (value.throughSequence === undefined ||
      (Number.isInteger(value.throughSequence) && Number(value.throughSequence) >= 0)) &&
    (value.factPrefixFingerprint === undefined || isSha256(value.factPrefixFingerprint)) &&
    (value.retentionPurpose === undefined || isNonBlankString(value.retentionPurpose)) &&
    (value.revocationMethod === undefined || isNonBlankString(value.revocationMethod)) &&
    isNonBlankString(value.grantedAt) &&
    !Number.isNaN(Date.parse(value.grantedAt)) &&
    (value.kind !== "feedback" ||
      (Number.isInteger(value.throughSequence) && isSha256(value.factPrefixFingerprint))) &&
    (value.kind !== "content" ||
      (value.contentLevel === "content" &&
        isNonBlankString(value.retentionPurpose) &&
        isNonBlankString(value.revocationMethod))) &&
    value.scopeFingerprint ===
      telemetryConsentScopeFingerprint({
        runId: value.runId,
        kind: value.kind,
        targetOrigin: value.targetOrigin,
        contentLevel: value.contentLevel,
        allowedFields: value.allowedFields,
        ...(value.throughSequence === undefined
          ? {}
          : { throughSequence: value.throughSequence as number }),
        ...(value.factPrefixFingerprint === undefined
          ? {}
          : { factPrefixFingerprint: value.factPrefixFingerprint as string }),
        ...(value.retentionPurpose === undefined
          ? {}
          : { retentionPurpose: value.retentionPurpose as string }),
        ...(value.revocationMethod === undefined
          ? {}
          : { revocationMethod: value.revocationMethod as string }),
      })
  );
}

function isEndpointOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.origin === value;
  } catch {
    return false;
  }
}

export function validateTelemetryConsentFact(value: unknown): TelemetryConsentFact {
  if (!isTelemetryConsentFact(value)) {
    throw new CoreMindError("run_state_corrupt", "Telemetry consent Fact 已损坏");
  }
  return structuredClone(value);
}

/** 在写入前验证 consent 只覆盖同一 Run 已经 durable 的 Fact 高水位。 */
export function validateTelemetryConsentBinding(
  value: unknown,
  persistedRecords: readonly RunStateRecord[],
): TelemetryConsentFact {
  const ordered = orderedFacts(persistedRecords);
  const runId = ordered[0]?.runId;
  if (!runId) throw new CoreMindError("run_state_corrupt", "Telemetry consent 缺少目标 Run");
  return validateTelemetryConsentForRecords(
    value,
    {
      version: 1,
      runId,
      sequence: ordered.length + 1,
      timestamp: new Date(0).toISOString(),
      kind: "telemetry_consent",
      payload: value,
    },
    ordered,
  );
}

/** 把 feedback 授权绑定到同一 Run 当时已持久化的精确 Fact 前缀。 */
export function telemetryFactPrefixFingerprint(
  records: readonly RunStateRecord[],
  throughSequence: number,
): string {
  const ordered = orderedFacts(records);
  if (
    !Number.isInteger(throughSequence) ||
    throughSequence < 1 ||
    throughSequence > ordered.length
  ) {
    throw new CoreMindError("run_state_corrupt", "Telemetry feedback 前缀超出已持久化 Fact 高水位");
  }
  return createHash("sha256")
    .update(canonicalJson(ordered.slice(0, throughSequence)), "utf8")
    .digest("hex");
}

function validateTelemetryConsentForRecords(
  value: unknown,
  consentRecord: RunStateRecord,
  records: readonly RunStateRecord[],
): TelemetryConsentFact {
  const consent = validateTelemetryConsentFact(value);
  if (consent.runId !== consentRecord.runId) {
    throw new CoreMindError("run_state_corrupt", "Telemetry consent 绑定了不同 Run");
  }
  if (consent.kind === "feedback") {
    const throughSequence = consent.throughSequence!;
    if (throughSequence >= consentRecord.sequence) {
      throw new CoreMindError(
        "run_state_corrupt",
        "Telemetry feedback consent 不能预授权未来 Fact",
      );
    }
    if (
      consent.factPrefixFingerprint !== telemetryFactPrefixFingerprint(records, throughSequence)
    ) {
      throw new CoreMindError("run_state_corrupt", "Telemetry feedback Fact 前缀指纹不匹配");
    }
  }
  return consent;
}

export function validateTelemetryConfigurationFact(value: unknown): TelemetryConfigurationFact {
  if (!isRecord(value)) {
    throw new CoreMindError("run_state_corrupt", "Telemetry 配置 Fact 已损坏");
  }
  const mode = value.mode;
  const contentLevel = value.contentLevel;
  const allowedFields = value.allowedFields;
  const endpointOrigin = value.endpointOrigin;
  if (
    value.schemaVersion !== 1 ||
    !(mode === "DISABLED" || mode === "FEEDBACK_ONLY" || mode === "FULL") ||
    !(contentLevel === "metrics_only" || contentLevel === "content") ||
    !isCanonicalStringList(allowedFields) ||
    !isNonBlankString(value.configuredAt) ||
    Number.isNaN(Date.parse(value.configuredAt)) ||
    (endpointOrigin !== undefined &&
      (typeof endpointOrigin !== "string" || !isEndpointOrigin(endpointOrigin))) ||
    (mode !== "DISABLED" && typeof endpointOrigin !== "string")
  ) {
    throw new CoreMindError("run_state_corrupt", "Telemetry 配置 Fact 已损坏");
  }
  return structuredClone(value) as unknown as TelemetryConfigurationFact;
}

/**
 * 构造供 Core 校验的出站策略收据；真实 DNS/TLS 与网络策略必须由受信任 Adapter 执行。
 */
export function createTelemetryEgressAuthorization(input: {
  targetOrigin: string;
  resolvedAddresses: string[];
}): TelemetryEgressAuthorization {
  if (
    !isEndpointOrigin(input.targetOrigin) ||
    input.resolvedAddresses.length === 0 ||
    input.resolvedAddresses.some((address) => isIP(address) === 0)
  ) {
    throw new Error("Telemetry egress authorization 缺少合法 origin 或解析地址");
  }
  const value = {
    schemaVersion: 1 as const,
    targetOrigin: input.targetOrigin,
    resolvedAddresses: [...new Set(input.resolvedAddresses)].sort(),
    redirectPolicy: "deny" as const,
    proxyPolicy: "deny" as const,
    tlsPolicy: "strict" as const,
  };
  return {
    ...value,
    policyFingerprint: createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"),
  };
}

function validateTelemetryEgressAuthorization(
  value: unknown,
  endpointOrigin: string,
): TelemetryEgressAuthorization {
  if (!isRecord(value)) throw new Error("缺少 Telemetry egress authorization");
  const expected = createTelemetryEgressAuthorization({
    targetOrigin: endpointOrigin,
    resolvedAddresses: Array.isArray(value.resolvedAddresses)
      ? value.resolvedAddresses.filter((item): item is string => isNonBlankString(item))
      : [],
  });
  if (
    value.schemaVersion !== 1 ||
    value.targetOrigin !== endpointOrigin ||
    !Array.isArray(value.resolvedAddresses) ||
    value.resolvedAddresses.length === 0 ||
    !isCanonicalStringList(value.resolvedAddresses) ||
    !value.resolvedAddresses.every((address) => isIP(address) !== 0) ||
    value.redirectPolicy !== "deny" ||
    value.proxyPolicy !== "deny" ||
    value.tlsPolicy !== "strict" ||
    value.policyFingerprint !== expected.policyFingerprint
  ) {
    throw new Error("Telemetry egress authorization 与配置目标不一致");
  }
  return structuredClone(value) as unknown as TelemetryEgressAuthorization;
}

function failureCodeOf(error: unknown): TelemetryFailureCode {
  return error instanceof TelemetryExporterError ? error.code : "exporter_failed";
}

type InvocationResult<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
  | { status: "timed_out" };

function invokeBeforeDeadline<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>,
  deadline: number,
): Promise<InvocationResult<T>> {
  return invokeWithin(invoke, Math.max(0, deadline - Date.now()));
}

async function invokeWithin<T>(
  invoke: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
): Promise<InvocationResult<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => invoke(controller.signal))
        .then(
          (value) => ({ status: "fulfilled", value }) as const,
          (reason) => ({ status: "rejected", reason }) as const,
        ),
      new Promise<{ status: "timed_out" }>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve({ status: "timed_out" });
          },
          Math.max(0, timeoutMs),
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function canonicalAuthorizationRecords(records: readonly RunStateRecord[]): RunStateRecord[] {
  const byIdentity = new Map<string, RunStateRecord>();
  for (const record of records) {
    const identity = identityOf(record);
    const previous = byIdentity.get(identity);
    if (previous && canonicalJson(previous) !== canonicalJson(record)) {
      throw new CoreMindError("run_state_corrupt", "Telemetry 输入包含身份相同但内容冲突的 Fact");
    }
    byIdentity.set(identity, record);
  }
  return orderedFacts([...byIdentity.values()]);
}

function isCanonicalStringList(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => isNonBlankString(item))) return false;
  const canonical = [...new Set(value)].sort();
  return (
    canonical.length === value.length && canonical.every((item, index) => item === value[index])
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
