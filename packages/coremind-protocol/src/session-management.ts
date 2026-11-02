import { type Static, Type } from "@sinclair/typebox";

const Id = Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" });
const SessionId = Type.String({ pattern: "^[a-zA-Z0-9_-]+$", maxLength: 256 });
const Hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Sleep = Type.Object(
  { sleepId: Id, wakeAt: Type.Integer({ minimum: 0, maximum: 8_640_000_000_000_000 }) },
  { additionalProperties: false },
);
const Task = Type.Object(
  {
    taskId: Id,
    type: Id,
    version: Type.Integer({ minimum: 1 }),
    phase: Id,
    status: Type.Union(
      (["ready", "paused", "sleeping", "completed", "cancelled"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    checkpoint: Type.Unknown(),
    pendingRunId: Type.Optional(Id),
    sleep: Type.Optional(Sleep),
  },
  { additionalProperties: false },
);
const Call = Type.Object(
  {
    key: Id,
    tool: Type.String({ minLength: 1 }),
    args: Type.Unknown(),
    signature: Hash,
    stepId: Hash,
    status: Type.Union(
      (["pending", "completed", "failed", "cancelled"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    error: Type.Optional(Type.String()),
    result: Type.Optional(
      Type.Object(
        {
          content: Type.Array(Type.Record(Type.String(), Type.Unknown())),
          details: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
    ),
    runId: Id,
    phase: Id,
    version: Type.Integer({ minimum: 1 }),
    authority: Hash,
  },
  { additionalProperties: false },
);
const NodeRef = Type.Object(
  { sessionId: SessionId, entryId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
const Tree = Type.Object(
  {
    sessionId: SessionId,
    activeBranch: Type.String({ minLength: 1 }),
    branches: Type.Array(
      Type.Object(
        { id: Type.String({ minLength: 1 }), leafId: Type.Union([Type.Null(), Type.String()]) },
        { additionalProperties: false },
      ),
    ),
    nodes: Type.Array(
      Type.Object(
        {
          id: Type.String({ minLength: 1 }),
          parentId: Type.Union([Type.Null(), Type.String()]),
          seq: Type.Integer({ minimum: 0 }),
          type: Type.Union(
            (
              [
                "message",
                "model_change",
                "thinking_level_change",
                "active_tools_change",
                "compaction",
                "branch_summary",
                "custom",
              ] as const
            ).map((value) => Type.Literal(value)),
          ),
          message: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
          summary: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
    forkedFrom: Type.Optional(NodeRef),
  },
  { additionalProperties: false },
);

/** 任务定义只由宿主注册；线协议不接收执行器、模块路径或凭据配置。 */
export const ProtocolV2TaskRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal("2.0"),
    id: Type.Union([Type.String(), Type.Number()]),
    method: Type.Literal("task"),
    params: Type.Union([
      Type.Object(
        {
          sessionId: SessionId,
          action: Type.Literal("start"),
          taskId: Id,
          type: Id,
          checkpoint: Type.Unknown(),
        },
        { additionalProperties: false },
      ),
      ...(["query", "resume", "cancel", "calls"] as const).map((action) =>
        Type.Object(
          { sessionId: SessionId, action: Type.Literal(action), taskId: Id },
          { additionalProperties: false },
        ),
      ),
      Type.Object(
        { sessionId: SessionId, action: Type.Literal("wake"), taskId: Id, wakeId: Id, sleepId: Id },
        { additionalProperties: false },
      ),
      Type.Object(
        { sessionId: SessionId, action: Type.Literal("next_wake") },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export const ProtocolV2TaskResultSchema = Type.Union([
  ...(["start", "resume", "cancel"] as const).map((action) =>
    Type.Object(
      {
        schemaVersion: Type.Literal(1),
        sessionId: SessionId,
        action: Type.Literal(action),
        taskId: Id,
        task: Task,
      },
      { additionalProperties: false },
    ),
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      sessionId: SessionId,
      action: Type.Literal("query"),
      taskId: Id,
      task: Type.Union([Task, Type.Null()]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      sessionId: SessionId,
      action: Type.Literal("wake"),
      taskId: Id,
      wakeId: Id,
      sleepId: Id,
      task: Task,
      wakeStatus: Type.Union(
        (["accepted", "duplicate", "not_due", "stale", "terminal"] as const).map((value) =>
          Type.Literal(value),
        ),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      sessionId: SessionId,
      action: Type.Literal("calls"),
      taskId: Id,
      calls: Type.Array(Call),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      schemaVersion: Type.Literal(1),
      sessionId: SessionId,
      action: Type.Literal("next_wake"),
      deadline: Type.Union([
        Type.Null(),
        Type.Composite(
          [Sleep, Type.Object({ taskId: Id, remainingMs: Type.Integer({ minimum: 0 }) })],
          { additionalProperties: false },
        ),
      ]),
    },
    { additionalProperties: false },
  ),
]);

export const ProtocolV2SessionRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal("2.0"),
    protocolVersion: Type.Literal("2.0"),
    id: Type.Union([Type.String(), Type.Number()]),
    method: Type.Literal("session"),
    params: Type.Union([
      Type.Object(
        { sessionId: SessionId, action: Type.Literal("inspect") },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          sessionId: SessionId,
          action: Type.Literal("create"),
          branchId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
          at: Type.Union([NodeRef, Type.Null()]),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          sessionId: SessionId,
          action: Type.Literal("select"),
          branchId: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { sessionId: SessionId, action: Type.Literal("fork"), at: NodeRef },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export const ProtocolV2SessionResultSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    sessionId: SessionId,
    action: Type.Union(
      (["inspect", "create", "select", "fork"] as const).map((value) => Type.Literal(value)),
    ),
    tree: Tree,
  },
  { additionalProperties: false },
);

export type ProtocolV2TaskRequest = Static<typeof ProtocolV2TaskRequestSchema>;
export type ProtocolV2TaskResult = Static<typeof ProtocolV2TaskResultSchema>;
export type ProtocolV2SessionRequest = Static<typeof ProtocolV2SessionRequestSchema>;
export type ProtocolV2SessionResult = Static<typeof ProtocolV2SessionResultSchema>;
