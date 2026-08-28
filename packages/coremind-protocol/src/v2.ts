import { createHash } from "node:crypto";
import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ErrorCodeSchema } from "./error-contract.js";

export const PROTOCOL_V2_VERSION = "2.0" as const;

const RpcIdSchema = Type.Union([Type.String(), Type.Number()]);
const VersionSchema = Type.String({ pattern: "^[0-9]+\\.[0-9]+$" });

export const ProtocolV2InitializeRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    id: RpcIdSchema,
    method: Type.Literal("initialize"),
    params: Type.Object(
      {
        protocolRange: Type.Object(
          {
            minVersion: VersionSchema,
            maxVersion: VersionSchema,
          },
          { additionalProperties: false },
        ),
        capabilities: Type.Optional(
          Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
        ),
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

export const ProtocolV2RunRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("run"),
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

export const ProtocolV2ChatRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("chat"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        agent: Type.String({ minLength: 1 }),
        message: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolV2ResumeRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("resume"),
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

const ProtocolV2ControlBaseSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  controlId: Type.String({ minLength: 1 }),
  runId: Type.String({ minLength: 1 }),
});

export const ProtocolV2ControlCommandSchema = Type.Union([
  Type.Composite([
    ProtocolV2ControlBaseSchema,
    Type.Object({ type: Type.Literal("cancel"), reason: Type.Optional(Type.String()) }),
  ]),
  Type.Composite([
    ProtocolV2ControlBaseSchema,
    Type.Object({
      type: Type.Literal("approval"),
      approvalId: Type.String({ minLength: 1 }),
      decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
    }),
  ]),
  Type.Composite([
    ProtocolV2ControlBaseSchema,
    Type.Object({ type: Type.Literal("steering"), message: Type.String({ minLength: 1 }) }),
  ]),
  Type.Composite([
    ProtocolV2ControlBaseSchema,
    Type.Object({ type: Type.Literal("follow_up"), message: Type.String({ minLength: 1 }) }),
  ]),
]);

export const ProtocolV2ControlRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("control"),
    params: ProtocolV2ControlCommandSchema,
  },
  { additionalProperties: false },
);

export const ProtocolV2EventsRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("events"),
    params: Type.Object(
      {
        runId: Type.String({ minLength: 1 }),
        afterSequence: Type.Integer({ minimum: 0 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolV2QueryRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("query"),
    params: Type.Object({ runId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  },
  { additionalProperties: false },
);

export const ProtocolV2RequestSchema = Type.Union([
  ProtocolV2InitializeRequestSchema,
  ProtocolV2RunRequestSchema,
  ProtocolV2ChatRequestSchema,
  ProtocolV2ResumeRequestSchema,
  ProtocolV2ControlRequestSchema,
  ProtocolV2EventsRequestSchema,
  ProtocolV2QueryRequestSchema,
]);

const ProtocolV2TimestampSchema = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$",
});

export const ProtocolV2InitializeResultSchema = Type.Object(
  {
    selectedProtocol: Type.Literal(PROTOCOL_V2_VERSION),
    runtime: Type.Literal("node"),
    warnings: Type.Array(Type.String()),
    serverCapabilities: Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true }),
    schemaFingerprint: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
    migration: Type.Object(
      {
        v1Supported: Type.Boolean(),
        v1SupportedThrough: Type.String({ minLength: 1 }),
        earliestRemoval: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ProtocolV2RunHandleSchema = Type.Object(
  {
    runId: Type.String({ minLength: 1 }),
    acceptedAt: ProtocolV2TimestampSchema,
    initialCursor: Type.Literal(0),
    selectedProtocol: Type.Literal(PROTOCOL_V2_VERSION),
    availableControls: Type.Array(
      Type.Union([
        Type.Literal("cancel"),
        Type.Literal("approval"),
        Type.Literal("steering"),
        Type.Literal("follow_up"),
      ]),
      { uniqueItems: true },
    ),
  },
  { additionalProperties: false },
);

const ProtocolV2EventEnvelopeBaseSchema = Type.Object(
  {
    protocolVersion: Type.Literal(PROTOCOL_V2_VERSION),
    eventSchemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    sequence: Type.Integer({ minimum: 1 }),
    eventId: Type.String({ minLength: 1 }),
    timestamp: ProtocolV2TimestampSchema,
    turnId: Type.Optional(Type.String({ minLength: 1 })),
    stepId: Type.Optional(Type.String({ minLength: 1 })),
    callId: Type.Optional(Type.String({ minLength: 1 })),
    approvalId: Type.Optional(Type.String({ minLength: 1 })),
    receiptId: Type.Optional(Type.String({ minLength: 1 })),
    parentRunId: Type.Optional(Type.String({ minLength: 1 })),
    childRunId: Type.Optional(Type.String({ minLength: 1 })),
    delegationId: Type.Optional(Type.String({ minLength: 1 })),
    ignorable: Type.Boolean(),
    sensitivity: Type.Literal("local"),
  },
  { additionalProperties: false },
);

const OptionalString = Type.Optional(Type.String());
const OptionalNumber = Type.Optional(Type.Number());
const OptionalBoolean = Type.Optional(Type.Boolean());
const StringArray = Type.Array(Type.String());

const ResolvedToolCapabilitySchema = Type.Object(
  {
    tool: Type.String(),
    effect: Type.Union([
      Type.Literal("none"),
      Type.Literal("workspace"),
      Type.Literal("process"),
      Type.Literal("network"),
      Type.Literal("external"),
      Type.Literal("unknown"),
    ]),
    replay: Type.Union([
      Type.Literal("safe"),
      Type.Literal("idempotent"),
      Type.Literal("unsafe"),
      Type.Literal("unknown"),
    ]),
    concurrency: Type.Union([
      Type.Literal("parallel"),
      Type.Literal("run_serial"),
      Type.Literal("workspace_exclusive"),
    ]),
    checkpoint: Type.Union([
      Type.Literal("none"),
      Type.Literal("required"),
      Type.Literal("unsupported"),
    ]),
    durability: Type.Union([Type.Literal("ordinary"), Type.Literal("critical")]),
    source: Type.Union([
      Type.Literal("builtin"),
      Type.Literal("registered"),
      Type.Literal("inferred"),
      Type.Literal("fallback"),
    ]),
    resolution: Type.Union([Type.Literal("resolved"), Type.Literal("fallback")]),
    issues: StringArray,
  },
  { additionalProperties: false },
);

const RecoveryDispositionSchema = Type.Union([
  Type.Literal("replay_safe"),
  Type.Literal("requires_proof"),
  Type.Literal("requires_human"),
  Type.Literal("forbidden"),
]);

const ToolEffectSchema = Type.Object(
  {
    operations: Type.Array(
      Type.Union([
        Type.Literal("read"),
        Type.Literal("write"),
        Type.Literal("process"),
        Type.Literal("network"),
        Type.Literal("external"),
      ]),
    ),
    paths: StringArray,
    urls: StringArray,
    reversible: Type.Boolean(),
    declared: Type.Boolean(),
  },
  { additionalProperties: false },
);

const EffectReceiptBindingSchema = Type.Object(
  {
    version: Type.Literal(1),
    runId: Type.String(),
    turnId: Type.String(),
    agent: Type.String(),
    stepId: OptionalString,
    callId: Type.String(),
    tool: Type.String(),
    argumentsFingerprint: Type.String(),
    capabilityFingerprint: Type.String(),
  },
  { additionalProperties: false },
);

const ToolCallResultAxesSchema = Type.Partial(
  Type.Object(
    {
      executionOutcome: Type.Union([
        Type.Literal("not_invoked"),
        Type.Literal("returned"),
        Type.Literal("threw"),
        Type.Literal("timed_out"),
        Type.Literal("aborted"),
      ]),
      effectState: Type.Union([
        Type.Literal("not_started"),
        Type.Literal("started"),
        Type.Literal("committed"),
        Type.Literal("unknown"),
      ]),
      persistenceState: Type.Union([
        Type.Literal("pending"),
        Type.Literal("durable"),
        Type.Literal("failed"),
        Type.Literal("unknown"),
      ]),
      recoveryDisposition: RecoveryDispositionSchema,
      cleanupState: Type.Union([
        Type.Literal("not_needed"),
        Type.Literal("pending"),
        Type.Literal("quiescent"),
        Type.Literal("failed"),
      ]),
      authorizationState: Type.Union([
        Type.Literal("pending"),
        Type.Literal("allowed"),
        Type.Literal("approved"),
        Type.Literal("denied"),
        Type.Literal("expired"),
      ]),
      environmentState: Type.Union([
        Type.Literal("available"),
        Type.Literal("degraded"),
        Type.Literal("unavailable"),
      ]),
    },
    { additionalProperties: false },
  ),
);

const ToolCallPhaseSchema = Type.Union([
  Type.Literal("call_recorded"),
  Type.Literal("capability_resolved"),
  Type.Literal("policy_resolved"),
  Type.Literal("approval_resolved"),
  Type.Literal("lease_acquired"),
  Type.Literal("checkpoint_durable"),
  Type.Literal("started_durable"),
  Type.Literal("executing"),
  Type.Literal("observed"),
  Type.Literal("result_durable"),
  Type.Literal("terminal"),
]);

const ToolCallPhaseResolutionSchema = Type.Union([
  Type.Object(
    {
      phase: ToolCallPhaseSchema,
      status: Type.Literal("completed"),
      result: Type.Optional(ToolCallResultAxesSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      phase: ToolCallPhaseSchema,
      status: Type.Union([Type.Literal("skipped"), Type.Literal("failed")]),
      reason: Type.String(),
      result: Type.Optional(ToolCallResultAxesSchema),
    },
    { additionalProperties: false },
  ),
]);

const ProtocolV2EventPayloadSchemas = [
  Type.Object(
    {
      type: Type.Literal("agent_start"),
      agent: Type.String(),
      stepId: OptionalString,
      turnId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("turn_end"),
      agent: Type.String(),
      stepId: OptionalString,
      turnId: OptionalString,
      tokens: OptionalNumber,
      inputTokens: OptionalNumber,
      outputTokens: OptionalNumber,
      cacheReadTokens: OptionalNumber,
      cacheWriteTokens: OptionalNumber,
      promptCacheStatus: Type.Optional(
        Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
      ),
      costUsd: OptionalNumber,
      requestsAnotherTurn: OptionalBoolean,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("text_delta"),
      agent: Type.String(),
      delta: Type.String(),
      stepId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_call"),
      agent: Type.String(),
      tool: Type.String(),
      args: Type.Unknown(),
      argumentsFingerprint: OptionalString,
      callId: OptionalString,
      idempotencyKey: OptionalString,
      stepId: OptionalString,
      turnId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_result"),
      agent: Type.String(),
      tool: Type.String(),
      isError: Type.Boolean(),
      callId: OptionalString,
      idempotencyKey: OptionalString,
      stepId: OptionalString,
      turnId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_attempt"),
      attemptId: Type.String(),
      previousReceiptId: Type.String(),
      attempt: Type.Integer({ minimum: 1 }),
      agent: Type.String(),
      tool: Type.String(),
      callId: Type.String(),
      stepId: OptionalString,
      argumentsFingerprint: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("capability_resolved"),
      agent: Type.String(),
      tool: Type.String(),
      callId: Type.String(),
      stepId: OptionalString,
      capability: ResolvedToolCapabilitySchema,
      recoveryDisposition: RecoveryDispositionSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("workspace_lease"),
      status: Type.Union([
        Type.Literal("acquired"),
        Type.Literal("released"),
        Type.Literal("recovery_required"),
      ]),
      canonicalRoot: Type.String(),
      lane: Type.Union([
        Type.Literal("parallel"),
        Type.Literal("run_serial"),
        Type.Literal("workspace_exclusive"),
      ]),
      owner: Type.Object(
        { runId: Type.String(), callId: Type.String(), pid: Type.Integer() },
        { additionalProperties: false },
      ),
      agent: Type.String(),
      callId: Type.String(),
      stepId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("effect_receipt"),
      idempotencyKey: Type.String(),
      tool: Type.String(),
      status: Type.Union([
        Type.Literal("not_started"),
        Type.Literal("started"),
        Type.Literal("committed"),
        Type.Literal("unknown"),
      ]),
      agent: OptionalString,
      callId: OptionalString,
      stepId: OptionalString,
      turnId: OptionalString,
      binding: Type.Optional(EffectReceiptBindingSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("step_start"), stepId: Type.String(), kind: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("step_output"),
      stepId: Type.String(),
      agent: Type.String(),
      text: Type.String(),
      saveAs: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("step_resumed"), stepId: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("step_end"), stepId: Type.String(), ok: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("loop_state"),
      from: Type.Union([
        Type.Literal("idle"),
        Type.Literal("planning"),
        Type.Literal("executing"),
        Type.Literal("verifying"),
        Type.Literal("repairing"),
        Type.Literal("paused"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("aborted"),
        Type.Literal("timeout"),
        Type.Literal("budget_exceeded"),
      ]),
      to: Type.Union([
        Type.Literal("idle"),
        Type.Literal("planning"),
        Type.Literal("executing"),
        Type.Literal("verifying"),
        Type.Literal("repairing"),
        Type.Literal("paused"),
        Type.Literal("succeeded"),
        Type.Literal("failed"),
        Type.Literal("aborted"),
        Type.Literal("timeout"),
        Type.Literal("budget_exceeded"),
      ]),
      trigger: Type.String(),
      iteration: Type.Integer({ minimum: 0 }),
      repairs: Type.Integer({ minimum: 0 }),
      reason: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("retry"),
      scope: Type.Union([Type.Literal("provider"), Type.Literal("workflow")]),
      attempt: Type.Integer({ minimum: 1 }),
      stepId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("approval_required"),
      approvalId: Type.String(),
      runId: Type.String(),
      agent: Type.String(),
      tool: Type.String(),
      args: Type.Unknown(),
      argumentsFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      delegationInputFingerprint: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
      risk: Type.Union([Type.Literal("low"), Type.Literal("high")]),
      effect: ToolEffectSchema,
      capability: Type.Optional(ResolvedToolCapabilitySchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("approval_resolved"),
      approvalId: Type.String(),
      runId: Type.String(),
      decision: Type.Union([Type.Literal("allow"), Type.Literal("deny")]),
      argumentsFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
      delegationInputFingerprint: Type.Optional(Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("policy_denied"),
      agent: Type.String(),
      tool: Type.String(),
      reason: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("budget_exceeded"),
      dimension: Type.Union([
        Type.Literal("turns"),
        Type.Literal("toolCalls"),
        Type.Literal("toolFailures"),
        Type.Literal("tokens"),
        Type.Literal("costUsd"),
      ]),
      limit: Type.Number(),
      actual: Type.Number(),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("context_budget_resolved"),
      providerId: Type.String(),
      modelId: Type.String(),
      capabilityFingerprint: Type.String(),
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
      effectiveContextWindow: Type.Number(),
      reservedOutputTokens: Type.Number(),
      availableInputTokens: Type.Number(),
      messageTokens: Type.Number(),
      stablePrefixTokens: Type.Number(),
      toolSchemaTokens: Type.Number(),
      structuredOutputTokens: Type.Number(),
      multimodalTokens: Type.Number(),
      protocolOverheadTokens: Type.Number(),
      safetyMarginTokens: Type.Number(),
      estimator: Type.Literal("pi-agent-core-estimate-v1"),
      evidence: Type.Array(
        Type.Union([
          Type.Literal("safe_context_intersection"),
          Type.Literal("assumed_context_window"),
        ]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("context_compacted"),
      beforeTokens: Type.Number(),
      afterTokens: Type.Number(),
      removedMessages: Type.Number(),
      strategy: Type.Union([Type.Literal("deterministic-v1"), Type.Literal("task-state-v1")]),
      reason: Type.Literal("threshold"),
      summaryFingerprint: Type.String(),
      capabilityFingerprint: OptionalString,
      lineageDepth: OptionalNumber,
      rebuiltFromCanonical: OptionalBoolean,
      trigger: Type.Optional(
        Type.Union([
          Type.Literal("threshold"),
          Type.Literal("model_switch"),
          Type.Literal("provider_overflow"),
        ]),
      ),
      sessionEntryId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("context_compaction_failed"),
      message: Type.String(),
      preservedMessages: Type.Number(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("context_lifecycle_failed"),
      code: Type.Union([
        Type.Literal("context_capability_conflict"),
        Type.Literal("context_budget_exhausted"),
        Type.Literal("context_artifact_missing"),
        Type.Literal("context_lineage_corrupt"),
      ]),
      reason: Type.String(),
      pausable: Type.Boolean(),
      preservedMessages: Type.Number(),
      providerCallBlocked: Type.Literal(true),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("context_prefix"), agent: Type.String(), fingerprint: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("provider_request"),
      requestId: Type.String(),
      agent: Type.String(),
      stepId: OptionalString,
      providerId: Type.String(),
      modelId: Type.String(),
      messageFingerprint: Type.String(),
      stablePrefixFingerprint: Type.String(),
      toolSchemaFingerprint: Type.String(),
      capabilityFingerprint: Type.String(),
      contextWorkingSetFingerprint: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("artifact_created"),
      artifactId: Type.String(),
      status: Type.Union([Type.Literal("stored"), Type.Literal("blocked")]),
      sizeBytes: Type.Number(),
      relativePath: OptionalString,
      sha256: OptionalString,
      mediaType: Type.String(),
      redaction: Type.Union([Type.Literal("none"), Type.Literal("blocked-secret")]),
      tool: Type.String(),
      callId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("extension_lifecycle"),
      extensionId: Type.String(),
      extensionVersion: Type.String(),
      lifecycle: Type.Union([
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
      durationMs: Type.Number(),
      error: OptionalString,
      denied: OptionalBoolean,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("checkpoint_created"),
      checkpointId: Type.String(),
      tool: Type.String(),
      callId: OptionalString,
      idempotencyKey: OptionalString,
      targetPath: OptionalString,
      reversible: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_execution_evidence"),
      agent: Type.String(),
      tool: Type.String(),
      callId: Type.String(),
      stepId: OptionalString,
      execution: Type.Object(
        {
          durationMs: Type.Number(),
          exitCode: Type.Union([Type.Integer(), Type.Null()]),
          commandSha256: OptionalString,
          testCommand: OptionalBoolean,
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("engineering_evidence"),
      stepId: Type.String(),
      textPassed: Type.Boolean(),
      passed: Type.Boolean(),
      successfulTestCommands: Type.Integer({ minimum: 0 }),
      regressionCommandMatched: Type.Boolean(),
      checkpointRecorded: Type.Boolean(),
      diffReviewed: Type.Boolean(),
      reasons: StringArray,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("agent_end"),
      agent: Type.String(),
      stepId: OptionalString,
      turnId: OptionalString,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("error"), message: Type.String(), fatal: Type.Boolean() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("input_receipt"),
      inputId: Type.String(),
      status: Type.Literal("pending"),
      contentFingerprint: Type.String(),
      timestamp: ProtocolV2TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("input_claimed"),
      inputId: Type.String(),
      status: Type.Literal("claimed"),
      turnId: Type.String(),
      timestamp: ProtocolV2TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("input_completed"),
      inputId: Type.String(),
      status: Type.Literal("completed"),
      timestamp: ProtocolV2TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("input_discarded"),
      inputId: Type.String(),
      status: Type.Literal("discarded"),
      timestamp: ProtocolV2TimestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { type: Type.Literal("quiescence_timeout"), timeoutMs: Type.Number() },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      type: Type.Literal("tool_lifecycle"),
      agent: Type.String(),
      callId: Type.String(),
      tool: Type.String(),
      stepId: OptionalString,
      turnId: OptionalString,
      resolution: ToolCallPhaseResolutionSchema,
    },
    { additionalProperties: false },
  ),
] as const;

const ProtocolV2TypedEventEnvelopeSchemas = ProtocolV2EventPayloadSchemas.map((payload) =>
  Type.Composite([
    ProtocolV2EventEnvelopeBaseSchema,
    Type.Object(
      { eventType: Type.Literal(payload.properties.type.const), payload },
      { additionalProperties: false },
    ),
  ]),
);

/** 38 类 CoreMind 事件均以 eventType/payload.type 判别并进入 schema fingerprint。 */
export const ProtocolV2EventEnvelopeSchema = Type.Union([
  ...ProtocolV2TypedEventEnvelopeSchemas,
  Type.Composite([
    ProtocolV2EventEnvelopeBaseSchema,
    Type.Object(
      {
        eventType: Type.String({ pattern: "^fact\\.[a-z][a-z0-9_]*$" }),
        payload: Type.Unknown(),
      },
      { additionalProperties: false },
    ),
  ]),
]);

export const ProtocolV2EventPageSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    afterSequence: Type.Integer({ minimum: 0 }),
    nextCursor: Type.Integer({ minimum: 0 }),
    hasMore: Type.Boolean(),
    events: Type.Array(ProtocolV2EventEnvelopeSchema),
  },
  { additionalProperties: false },
);

export const ProtocolV2QueryResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    runId: Type.String({ minLength: 1 }),
    derivedFromSequence: Type.Integer({ minimum: 1 }),
    projection: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ProtocolV2ControlReceiptSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    controlId: Type.String({ minLength: 1 }),
    runId: Type.String({ minLength: 1 }),
    status: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("applied"),
      Type.Literal("rejected"),
      Type.Literal("duplicate"),
      Type.Literal("conflict"),
    ]),
    acceptedSequence: Type.Optional(Type.Integer({ minimum: 1 })),
    appliedSequence: Type.Optional(Type.Integer({ minimum: 1 })),
    rejectedSequence: Type.Optional(Type.Integer({ minimum: 1 })),
    duplicateOf: Type.Optional(
      Type.Union([Type.Literal("accepted"), Type.Literal("applied"), Type.Literal("rejected")]),
    ),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ProtocolV2ErrorResponseSchema = Type.Object(
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

/** 客户端与 Host 共同锁定的完整 v2 线协议 schema 集。 */
export const PROTOCOL_V2_SCHEMA_BUNDLE = {
  request: ProtocolV2RequestSchema,
  initializeResult: ProtocolV2InitializeResultSchema,
  runHandle: ProtocolV2RunHandleSchema,
  eventEnvelope: ProtocolV2EventEnvelopeSchema,
  eventPage: ProtocolV2EventPageSchema,
  queryResult: ProtocolV2QueryResultSchema,
  controlReceipt: ProtocolV2ControlReceiptSchema,
  errorResponse: ProtocolV2ErrorResponseSchema,
} as const;

export const PROTOCOL_V2_SCHEMA_FINGERPRINT = `sha256:${createHash("sha256")
  .update(canonicalJson(PROTOCOL_V2_SCHEMA_BUNDLE))
  .digest("hex")}` as const;

export type ProtocolV2InitializeRequest = Static<typeof ProtocolV2InitializeRequestSchema>;
export type ProtocolV2RunRequest = Static<typeof ProtocolV2RunRequestSchema>;
export type ProtocolV2ChatRequest = Static<typeof ProtocolV2ChatRequestSchema>;
export type ProtocolV2ResumeRequest = Static<typeof ProtocolV2ResumeRequestSchema>;
export type ProtocolV2StartRequest =
  | ProtocolV2RunRequest
  | ProtocolV2ChatRequest
  | ProtocolV2ResumeRequest;
export type ProtocolV2ControlCommand = Static<typeof ProtocolV2ControlCommandSchema>;
export type ProtocolV2ControlRequest = Static<typeof ProtocolV2ControlRequestSchema>;
export type ProtocolV2EventsRequest = Static<typeof ProtocolV2EventsRequestSchema>;
export type ProtocolV2QueryRequest = Static<typeof ProtocolV2QueryRequestSchema>;
export type ProtocolV2Request = Static<typeof ProtocolV2RequestSchema>;
export type ProtocolV2InitializeResult = Static<typeof ProtocolV2InitializeResultSchema>;
export type ProtocolV2RunHandle = Static<typeof ProtocolV2RunHandleSchema>;
export type ProtocolV2EventEnvelope = Static<typeof ProtocolV2EventEnvelopeSchema>;
export type ProtocolV2EventPage = Static<typeof ProtocolV2EventPageSchema>;
export type ProtocolV2QueryResult = Static<typeof ProtocolV2QueryResultSchema>;
export type ProtocolV2ControlReceipt = Static<typeof ProtocolV2ControlReceiptSchema>;
export type ProtocolVersionRange = ProtocolV2InitializeRequest["params"]["protocolRange"];

export class ProtocolV2ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolV2ValidationError";
  }
}

export class ProtocolV2NegotiationError extends Error {
  readonly code = "protocol_version_unsupported" as const;

  constructor(range: ProtocolVersionRange) {
    super(`Protocol v2 Host 不支持客户端版本范围 ${range.minVersion}～${range.maxVersion}`);
    this.name = "ProtocolV2NegotiationError";
  }
}

/** 从客户端显式范围中选择 Host 当前唯一支持的 v2 版本。 */
export function negotiateProtocolV2(range: ProtocolVersionRange): typeof PROTOCOL_V2_VERSION {
  const selected = parseVersion(PROTOCOL_V2_VERSION);
  const minimum = parseVersion(range.minVersion);
  const maximum = parseVersion(range.maxVersion);
  if (
    selected === undefined ||
    minimum === undefined ||
    maximum === undefined ||
    compareVersion(minimum, maximum) > 0 ||
    compareVersion(selected, minimum) < 0 ||
    compareVersion(selected, maximum) > 0
  ) {
    throw new ProtocolV2NegotiationError(range);
  }
  return PROTOCOL_V2_VERSION;
}

/** 解析 v2 请求；连接级版本锁定由 ProtocolHost 负责。 */
export function parseProtocolV2Request(value: unknown): ProtocolV2Request {
  if (!Value.Check(ProtocolV2RequestSchema, value)) {
    const details = [...Value.Errors(ProtocolV2RequestSchema, value)]
      .map((error) => `${error.path || "/"}: ${error.message}`)
      .join("；");
    throw new ProtocolV2ValidationError(`无效的 CoreMind Protocol v2 请求：${details}`);
  }
  const parsed = Value.Parse(ProtocolV2RequestSchema, value) as ProtocolV2Request;
  if (parsed.method === "initialize") {
    const hasConfig = parsed.params.config !== undefined;
    const hasConfigPath = parsed.params.configPath !== undefined;
    if (hasConfig === hasConfigPath) {
      throw new ProtocolV2ValidationError("initialize 必须且只能提供 config 或 configPath 之一");
    }
  }
  return parsed;
}

function parseVersion(value: string): readonly [number, number] | undefined {
  const match = /^(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2])];
}

function compareVersion(left: readonly [number, number], right: readonly [number, number]): number {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
