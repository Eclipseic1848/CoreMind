import { type Static, Type } from "@sinclair/typebox";

/** 单次运行的多维预算，防止 Agent/Workflow 无边界执行。 */
export const RuntimeLimitsSchema = Type.Object({
  maxTurns: Type.Optional(Type.Integer({ minimum: 1, default: 20 })),
  maxSteps: Type.Optional(Type.Integer({ minimum: 1, default: 100 })),
  stepTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, default: 300_000 })),
  runTimeoutMs: Type.Optional(Type.Integer({ minimum: 0, default: 900_000 })),
  maxToolCalls: Type.Optional(Type.Integer({ minimum: 0, default: 50 })),
  maxToolFailures: Type.Optional(Type.Integer({ minimum: 0, default: 3 })),
  maxRetries: Type.Optional(Type.Integer({ minimum: 0, default: 3 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
});

/** 工具执行权限：用户决定授权强度，审计与 checkpoint 始终启用。 */
export const PermissionsConfigSchema = Type.Object({
  mode: Type.Optional(
    Type.Union([Type.Literal("ask"), Type.Literal("assisted"), Type.Literal("full")], {
      default: "ask",
    }),
  ),
  workspaceOnly: Type.Optional(Type.Boolean({ default: true })),
  network: Type.Optional(
    Type.Union([Type.Literal("ask"), Type.Literal("allow"), Type.Literal("deny")], {
      default: "ask",
    }),
  ),
  allow: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { default: [] })),
  deny: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { default: [] })),
});

/** 质量门禁预设；业务阈值由用户项目自行配置和确认。 */
export const QualityConfigSchema = Type.Object({
  profile: Type.Optional(
    Type.Union([Type.Literal("development"), Type.Literal("standard"), Type.Literal("strict")], {
      default: "standard",
    }),
  ),
  allowOverride: Type.Optional(Type.Boolean({ default: true })),
  minScenarioPassRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});

export type RuntimeLimitsConfig = Static<typeof RuntimeLimitsSchema>;
export type PermissionsConfig = Static<typeof PermissionsConfigSchema>;
export type QualityConfig = Static<typeof QualityConfigSchema>;
