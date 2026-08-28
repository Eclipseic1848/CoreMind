import { type Static, Type } from "@sinclair/typebox";
import {
  AgentConfigSchema,
  type AgentDelegationConfig,
  type DelegationBudgetConfig,
  type DelegationHierarchyLimitsConfig,
  type DelegationTargetConfig,
  SessionConfigSchema,
} from "./agent.js";
import { PermissionsConfigSchema, QualityConfigSchema, RuntimeLimitsSchema } from "./harness.js";
import { type LoopConfig, LoopConfigSchema } from "./loop.js";
import {
  type CustomProviderSchema,
  type EnvironmentValueRefSchema,
  ModelOptionsSchema,
  type ProviderRefSchema,
  ProviderSchema,
  type SecretRefSchema,
} from "./provider.js";
import { TelemetryConfigSchema } from "./telemetry.js";
import { type ScriptToolSchema, ToolConfigSchema, type ToolRefSchema } from "./tools.js";
import { WorkflowStepSchema } from "./workflow.js";

/**
 * CoreMind 配置文件顶层 schema（coremind.yaml / coremind.json）
 * 顶层只保留少量字段，全部可选字段有合理默认值，对新手友好。
 */
export const CoreMindConfigSchema = Type.Object({
  schemaVersion: Type.Literal(2, { description: "CoreMind 配置格式版本" }),
  name: Type.String({ minLength: 1, description: "智能体名称（必填）" }),
  description: Type.Optional(Type.String()),
  provider: Type.Optional(ProviderSchema),
  tools: Type.Optional(Type.Array(ToolConfigSchema, { default: [], description: "全局默认工具" })),
  options: Type.Optional(ModelOptionsSchema),
  agents: Type.Record(Type.String({ minLength: 1 }), AgentConfigSchema, {
    description: "多 agent 按名字定义",
  }),
  defaultAgent: Type.Optional(Type.String({ description: "缺省 agent 名，缺省为第一个" })),
  workflow: Type.Optional(Type.Array(WorkflowStepSchema)),
  loop: Type.Optional(LoopConfigSchema),
  session: Type.Optional(SessionConfigSchema),
  runtime: Type.Optional(RuntimeLimitsSchema),
  permissions: Type.Optional(PermissionsConfigSchema),
  quality: Type.Optional(QualityConfigSchema),
  telemetry: Type.Optional(TelemetryConfigSchema),
});

export type CoreMindConfig = Static<typeof CoreMindConfigSchema>;
export type AgentConfig = Static<typeof AgentConfigSchema>;
export type {
  AgentDelegationConfig,
  DelegationBudgetConfig,
  DelegationHierarchyLimitsConfig,
  DelegationTargetConfig,
};
export type ProviderConfig = Static<typeof ProviderSchema>;
export type ProviderRefConfig = Static<typeof ProviderRefSchema>;
export type CustomProviderConfig = Static<typeof CustomProviderSchema>;
export type SecretRef = Static<typeof SecretRefSchema>;
export type EnvironmentValueRef = Static<typeof EnvironmentValueRefSchema>;
export type ModelOptionsConfig = Static<typeof ModelOptionsSchema>;
export type ToolConfig = Static<typeof ToolConfigSchema>;
export type ToolRefConfig = Static<typeof ToolRefSchema>;
export type ScriptToolConfig = Static<typeof ScriptToolSchema>;
export type WorkflowStep = Static<typeof WorkflowStepSchema>;
export type { LoopConfig };
export type SessionConfig = Static<typeof SessionConfigSchema>;
