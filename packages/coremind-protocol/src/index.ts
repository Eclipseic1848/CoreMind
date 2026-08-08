import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const PROTOCOL_VERSION = "1.0" as const;

const RpcIdSchema = Type.Union([Type.String(), Type.Number()]);

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
      { input: Type.Optional(Type.String()), qualityOverride: Type.Optional(Type.Boolean()) },
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
      { agent: Type.String({ minLength: 1 }), message: Type.String() },
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
            { coremindCode: Type.Optional(Type.String()), details: Type.Optional(Type.Unknown()) },
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

export function createSuccessResponse(id: RpcId, result: unknown): ProtocolSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(
  id: RpcId,
  code: number,
  message: string,
  coremindCode?: string,
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
