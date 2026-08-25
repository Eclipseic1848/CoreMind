import { type Static, Type } from "@sinclair/typebox";

export const TelemetryModeSchema = Type.Union(
  [Type.Literal("DISABLED"), Type.Literal("FEEDBACK_ONLY"), Type.Literal("FULL")],
  { default: "DISABLED" },
);

export const TelemetryContentLevelSchema = Type.Union(
  [Type.Literal("metrics_only"), Type.Literal("content")],
  { default: "metrics_only" },
);

/** 本地观测始终开启；这里只配置可选的进程外投影通道。 */
export const TelemetryConfigSchema = Type.Object({
  mode: Type.Optional(TelemetryModeSchema),
  endpoint: Type.Optional(
    Type.String({
      minLength: 1,
      pattern: "^https?://",
      description: "显式授权的 Telemetry 目标；显示时只保留 origin",
    }),
  ),
  contentLevel: Type.Optional(TelemetryContentLevelSchema),
  allowedFields: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      default: [],
      uniqueItems: true,
      description: "content 二次授权允许的精确字段路径",
    }),
  ),
});

export type TelemetryConfig = Static<typeof TelemetryConfigSchema>;
export type TelemetryMode = Static<typeof TelemetryModeSchema>;
export type TelemetryContentLevel = Static<typeof TelemetryContentLevelSchema>;
