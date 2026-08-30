import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { type ErrorCode, ErrorCodeSchema } from "./error-contract.js";

export {
  ERROR_CODES,
  type ErrorCancelClass,
  type ErrorCode,
  type ErrorCodeInfo,
  ErrorCodeSchema,
  type ErrorHumanAction,
  type ErrorRetryClass,
  type ErrorRunStatus,
  type ErrorTerminality,
  isErrorCode,
  type NormalizedExternalErrorCode,
  normalizeExternalErrorCode,
} from "./error-contract.js";

export {
  negotiateProtocolV2,
  PROTOCOL_V2_SCHEMA_BUNDLE,
  PROTOCOL_V2_SCHEMA_FINGERPRINT,
  PROTOCOL_V2_VERSION,
  type ProtocolV2ChatRequest,
  ProtocolV2ChatRequestSchema,
  type ProtocolV2CheckpointRequest,
  ProtocolV2CheckpointRequestSchema,
  type ProtocolV2CheckpointResult,
  ProtocolV2CheckpointResultSchema,
  type ProtocolV2ControlCommand,
  ProtocolV2ControlCommandSchema,
  type ProtocolV2ControlReceipt,
  ProtocolV2ControlReceiptSchema,
  type ProtocolV2ControlRequest,
  ProtocolV2ControlRequestSchema,
  ProtocolV2ErrorResponseSchema,
  type ProtocolV2EventEnvelope,
  ProtocolV2EventEnvelopeSchema,
  type ProtocolV2EventPage,
  ProtocolV2EventPageSchema,
  type ProtocolV2EventsRequest,
  ProtocolV2EventsRequestSchema,
  type ProtocolV2InitializeRequest,
  ProtocolV2InitializeRequestSchema,
  type ProtocolV2InitializeResult,
  ProtocolV2InitializeResultSchema,
  ProtocolV2NegotiationError,
  type ProtocolV2PublicCheckpoint,
  ProtocolV2PublicCheckpointSchema,
  type ProtocolV2QueryRequest,
  ProtocolV2QueryRequestSchema,
  type ProtocolV2QueryResult,
  ProtocolV2QueryResultSchema,
  type ProtocolV2Request,
  ProtocolV2RequestSchema,
  type ProtocolV2ResumeRequest,
  ProtocolV2ResumeRequestSchema,
  type ProtocolV2RunHandle,
  ProtocolV2RunHandleSchema,
  type ProtocolV2RunRequest,
  ProtocolV2RunRequestSchema,
  type ProtocolV2StartRequest,
  type ProtocolV2ToolCallNotification,
  ProtocolV2ToolCallNotificationSchema,
  type ProtocolV2ToolCancelNotification,
  ProtocolV2ToolCancelNotificationSchema,
  type ProtocolV2ToolRegisterRequest,
  ProtocolV2ToolRegisterRequestSchema,
  type ProtocolV2ToolRegistrationReceipt,
  ProtocolV2ToolRegistrationReceiptSchema,
  type ProtocolV2ToolResultReceipt,
  ProtocolV2ToolResultReceiptSchema,
  type ProtocolV2ToolResultRequest,
  ProtocolV2ToolResultRequestSchema,
  ProtocolV2ValidationError,
  type ProtocolVersionRange,
  parseProtocolV2Request,
} from "./v2.js";

export const PROTOCOL_VERSION = "1.0" as const;

const RpcIdSchema = Type.Union([Type.String(), Type.Number()]);

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const NonNegativeIntegerSchema = Type.Integer({ minimum: 0 });
const NonNegativeNumberSchema = Type.Number({ minimum: 0 });
const TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
});

const OperationStateSchema = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("running"),
  Type.Literal("paused"),
  Type.Literal("aborting"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);

const DurableOperationSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    operationId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    correlationId: NonEmptyStringSchema,
    state: OperationStateSchema,
    transitionSequence: Type.Integer({ minimum: 1 }),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    pauseReason: Type.Optional(NonEmptyStringSchema),
    failureReason: Type.Optional(NonEmptyStringSchema),
  },
  { additionalProperties: false },
);

const RunOutcomeSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("paused"),
      Type.Literal("aborted"),
      Type.Literal("timeout"),
      Type.Literal("budget_exceeded"),
    ]),
    finishReason: NonEmptyStringSchema,
    error: Type.Optional(
      Type.Object(
        {
          code: ErrorCodeSchema,
          message: NonEmptyStringSchema,
          audit: Type.Optional(
            Type.Object({ originalCode: NonEmptyStringSchema }, { additionalProperties: false }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const RunMetricsSchema = Type.Object(
  {
    durationMs: NonNegativeNumberSchema,
    turns: NonNegativeIntegerSchema,
    steps: Type.Object(
      {
        total: NonNegativeIntegerSchema,
        succeeded: NonNegativeIntegerSchema,
        failed: NonNegativeIntegerSchema,
      },
      { additionalProperties: false },
    ),
    toolCalls: NonNegativeIntegerSchema,
    toolFailures: NonNegativeIntegerSchema,
    retries: NonNegativeIntegerSchema,
    tokens: Type.Optional(NonNegativeNumberSchema),
    costUsd: Type.Optional(NonNegativeNumberSchema),
    outputChars: NonNegativeIntegerSchema,
    context: Type.Optional(
      Type.Object(
        {
          inputTokens: NonNegativeIntegerSchema,
          outputTokens: NonNegativeIntegerSchema,
          cacheReadTokens: NonNegativeIntegerSchema,
          cacheWriteTokens: NonNegativeIntegerSchema,
          promptCacheStatus: Type.Union([
            Type.Literal("available"),
            Type.Literal("unavailable"),
            Type.Literal("unknown"),
          ]),
          compactions: NonNegativeIntegerSchema,
          lastSummaryFingerprint: Type.Optional(NonEmptyStringSchema),
          stablePrefixFingerprints: Type.Array(NonEmptyStringSchema),
          lastBudget: Type.Optional(
            Type.Object(
              {
                providerId: NonEmptyStringSchema,
                modelId: NonEmptyStringSchema,
                capabilityFingerprint: NonEmptyStringSchema,
                source: Type.Union([
                  Type.Literal("locked_catalog"),
                  Type.Literal("explicit_config"),
                  Type.Literal("provider_metadata"),
                  Type.Literal("conservative_fallback"),
                ]),
                confidence: Type.Union([
                  Type.Literal("verified"),
                  Type.Literal("declared"),
                  Type.Literal("assumed"),
                ]),
                effectiveContextWindow: NonNegativeIntegerSchema,
                reservedOutputTokens: NonNegativeIntegerSchema,
                availableInputTokens: NonNegativeIntegerSchema,
                messageTokens: NonNegativeIntegerSchema,
                estimator: Type.Literal("pi-agent-core-estimate-v1"),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    artifacts: Type.Optional(
      Type.Object(
        {
          stored: NonNegativeIntegerSchema,
          blocked: NonNegativeIntegerSchema,
          totalBytes: NonNegativeIntegerSchema,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const EvaluationReportSchema = Type.Object(
  {
    profile: Type.Union([
      Type.Literal("development"),
      Type.Literal("standard"),
      Type.Literal("strict"),
    ]),
    scenarioResults: Type.Array(
      Type.Object(
        {
          id: NonEmptyStringSchema,
          passed: Type.Boolean(),
          score: Type.Optional(Type.Number()),
          reason: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    qualityScores: Type.Record(Type.String(), Type.Number()),
    securityFindings: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

const ReleaseReadinessSchema = Type.Object(
  {
    ready: Type.Boolean(),
    blockers: Type.Array(Type.String()),
    warnings: Type.Array(Type.String()),
    overrideRecord: Type.Optional(
      Type.Object(
        { reason: NonEmptyStringSchema, recordedAt: TimestampSchema },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const TraceEventSchema = Type.Object(
  {
    eventId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    sequence: Type.Integer({ minimum: 1 }),
    timestamp: TimestampSchema,
    event: Type.Object({ type: NonEmptyStringSchema }, { additionalProperties: true }),
  },
  { additionalProperties: false },
);

const CheckpointRecordSchema = Type.Object(
  {
    version: Type.Literal(1),
    checkpointId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    operationId: Type.Optional(NonEmptyStringSchema),
    toolCallId: Type.Optional(NonEmptyStringSchema),
    idempotencyKey: Type.Optional(NonEmptyStringSchema),
    timestamp: TimestampSchema,
    tool: NonEmptyStringSchema,
    reversible: Type.Boolean(),
    targetPath: Type.Optional(NonEmptyStringSchema),
    existed: Type.Optional(Type.Boolean()),
    beforeSha256: Type.Optional(NonEmptyStringSchema),
    afterExisted: Type.Optional(Type.Boolean()),
    afterSha256: Type.Optional(NonEmptyStringSchema),
    reason: Type.Optional(Type.String()),
    snapshotFile: NonEmptyStringSchema,
  },
  { additionalProperties: false },
);

const ArtifactRecordSchema = Type.Object(
  {
    artifactId: NonEmptyStringSchema,
    status: Type.Union([Type.Literal("stored"), Type.Literal("blocked")]),
    relativePath: Type.Optional(NonEmptyStringSchema),
    sizeBytes: NonNegativeIntegerSchema,
    sha256: Type.Optional(NonEmptyStringSchema),
    mediaType: NonEmptyStringSchema,
    createdAt: TimestampSchema,
    retention: Type.Literal("run"),
    redaction: Type.Union([Type.Literal("none"), Type.Literal("blocked-secret")]),
  },
  { additionalProperties: false },
);

const LifecycleExtensionReceiptSchema = Type.Object(
  {
    extensionId: NonEmptyStringSchema,
    extensionVersion: NonEmptyStringSchema,
    event: Type.Union([
      Type.Literal("before-model"),
      Type.Literal("before-tool"),
      Type.Literal("after-tool"),
      Type.Literal("run-finished"),
    ]),
    status: Type.Union([
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("timed_out"),
    ]),
    durationMs: NonNegativeNumberSchema,
    error: Type.Optional(Type.String()),
    denied: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Worker、TypeScript SDK 与 Python SDK 共享的运行快照信封。 */
export const RunSnapshotSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    operation: DurableOperationSnapshotSchema,
    outcome: RunOutcomeSchema,
    metrics: RunMetricsSchema,
    evaluation: EvaluationReportSchema,
    releaseReadiness: ReleaseReadinessSchema,
    trace: Type.Array(TraceEventSchema),
    checkpoints: Type.Array(CheckpointRecordSchema),
    artifacts: Type.Array(ArtifactRecordSchema),
    extensions: Type.Array(LifecycleExtensionReceiptSchema),
    resumable: Type.Boolean(),
  },
  { additionalProperties: false },
);

const ToolEffectDeclarationSchema = Type.Object(
  {
    operations: Type.Array(
      Type.Union([
        Type.Literal("read"),
        Type.Literal("write"),
        Type.Literal("process"),
        Type.Literal("network"),
        Type.Literal("external"),
      ]),
      { minItems: 1, uniqueItems: true },
    ),
    reversible: Type.Boolean(),
    pathFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    urlFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  },
  { additionalProperties: false },
);

export const InitializeRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("initialize"),
    params: Type.Object(
      {
        protocolVersion: Type.Literal(PROTOCOL_VERSION),
        config: Type.Optional(Type.Unknown()),
        configPath: Type.Optional(Type.String({ minLength: 1 })),
        configDir: Type.Optional(Type.String({ minLength: 1 })),
        cwd: Type.Optional(Type.String({ minLength: 1 })),
        sessionId: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const RunRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("run"),
    params: Type.Object(
      {
        input: Type.Optional(Type.String()),
        qualityOverride: Type.Optional(Type.Boolean()),
        // 预生成 runId（D-1）：首事件前取消的可寻址方式；旧客户端不提供，行为不变
        runId: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ChatRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("chat"),
    params: Type.Object(
      {
        agent: Type.String({ minLength: 1 }),
        message: Type.String(),
        // 预生成 runId（D-1）：首事件前取消的可寻址方式；旧客户端不提供，行为不变
        runId: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CancelRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("cancel"),
    params: Type.Object({ runId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const ApproveRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("approve"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        approvalId: Type.String({ minLength: 1 }),
        decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CloseRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("close"),
    params: Type.Object({}, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const RegisterToolRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("register_tool"),
    params: Type.Object(
      {
        name: Type.String({ minLength: 1 }),
        description: Type.String({ minLength: 1 }),
        parameters: Type.Unknown(),
        effect: ToolEffectDeclarationSchema,
        label: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ToolResultRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("tool_result"),
    params: Type.Object(
      {
        callId: Type.String({ minLength: 1 }),
        result: Type.Optional(Type.Unknown()),
        error: Type.Optional(Type.String({ minLength: 1 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const InspectRunRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("inspect_run"),
    params: Type.Object({ runId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const ResumeRunRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("resume_run"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        input: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CheckpointDiffRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("checkpoint_diff"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        checkpointId: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const CheckpointRestoreRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("checkpoint_restore"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        checkpointId: Type.String({ minLength: 1 }),
        confirm: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolRequestSchema = Type.Union([
  InitializeRequestSchema,
  RunRequestSchema,
  ChatRequestSchema,
  CancelRequestSchema,
  ApproveRequestSchema,
  RegisterToolRequestSchema,
  ToolResultRequestSchema,
  InspectRunRequestSchema,
  ResumeRunRequestSchema,
  CheckpointDiffRequestSchema,
  CheckpointRestoreRequestSchema,
  CloseRequestSchema,
]);

export type InitializeRequest = Static<typeof InitializeRequestSchema>;
export type ProtocolRequest = Static<typeof ProtocolRequestSchema>;

export const ProtocolSuccessResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    result: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ProtocolErrorResponseSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    error: Type.Object(
      {
        code: Type.Integer(),
        message: Type.String(),
        data: Type.Optional(
          Type.Object(
            {
              coremindCode: Type.Optional(ErrorCodeSchema),
              details: Type.Optional(Type.Unknown()),
            },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolEventNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.Literal("event"),
    params: Type.Object(
      {
        protocolVersion: Type.Literal(PROTOCOL_VERSION),
        runId: Type.String({ minLength: 1 }),
        sequence: Type.Integer({ minimum: 0 }),
        timestamp: Type.String({ minLength: 1 }),
        event: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const PythonToolCallNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    method: Type.Literal("python_tool_call"),
    params: Type.Object(
      {
        protocolVersion: Type.Literal(PROTOCOL_VERSION),
        runId: Type.String({ minLength: 1 }),
        callId: Type.String({ minLength: 1 }),
        tool: Type.String({ minLength: 1 }),
        args: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type RpcId = Static<typeof RpcIdSchema>;
export type ProtocolRunSnapshot = Static<typeof RunSnapshotSchema>;
export type ProtocolSuccessResponse = Static<typeof ProtocolSuccessResponseSchema>;
export type ProtocolErrorResponse = Static<typeof ProtocolErrorResponseSchema>;
export type ProtocolEventNotification = Static<typeof ProtocolEventNotificationSchema>;
export type PythonToolCallNotification = Static<typeof PythonToolCallNotificationSchema>;

export class ProtocolValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function parseProtocolRequest(value: unknown): ProtocolRequest {
  if (!Value.Check(ProtocolRequestSchema, value)) {
    const details = [...Value.Errors(ProtocolRequestSchema, value)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("；");
    throw new ProtocolValidationError(`无效的 CoreMind Protocol 请求：${details}`);
  }
  const parsed = Value.Parse(ProtocolRequestSchema, value) as ProtocolRequest;
  if (parsed.method === "initialize") {
    const hasConfig = parsed.params.config !== undefined;
    const hasConfigPath = parsed.params.configPath !== undefined;
    if (hasConfig === hasConfigPath) {
      throw new ProtocolValidationError("initialize 必须且只能提供 config 或 configPath 之一");
    }
  }
  if (parsed.method === "tool_result") {
    const hasResult = parsed.params.result !== undefined;
    const hasError = parsed.params.error !== undefined;
    if (hasResult === hasError) {
      throw new ProtocolValidationError("tool_result 必须且只能提供 result 或 error 之一");
    }
  }
  return parsed;
}

export function parseRunSnapshot(value: unknown): ProtocolRunSnapshot {
  if (!Value.Check(RunSnapshotSchema, value)) {
    const details = [...Value.Errors(RunSnapshotSchema, value)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("；");
    throw new ProtocolValidationError(`无效的 CoreMind RunSnapshot：${details}`);
  }
  // 快照验证不能清理事件的扩展字段，否则 snapshot.trace 会与权威 trace 发生漂移。
  return structuredClone(value) as ProtocolRunSnapshot;
}

export function createSuccessResponse(id: RpcId, result: unknown): ProtocolSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(
  id: RpcId,
  code: number,
  message: string,
  coremindCode?: ErrorCode,
  details?: unknown,
): ProtocolErrorResponse {
  const data =
    coremindCode !== undefined || details !== undefined
      ? {
          ...(coremindCode !== undefined ? { coremindCode } : {}),
          ...(details !== undefined ? { details } : {}),
        }
      : undefined;
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data ? { data } : {}) },
  };
}

export function createEventNotification(
  params: Omit<ProtocolEventNotification["params"], "protocolVersion">,
): ProtocolEventNotification {
  return {
    jsonrpc: "2.0",
    method: "event",
    params: { protocolVersion: PROTOCOL_VERSION, ...params },
  };
}

export function createPythonToolCallNotification(
  params: Omit<PythonToolCallNotification["params"], "protocolVersion">,
): PythonToolCallNotification {
  return {
    jsonrpc: "2.0",
    method: "python_tool_call",
    params: { protocolVersion: PROTOCOL_VERSION, ...params },
  };
}
