// CoreMind 配置层：schema、解析、校验

export {
  ConfigParseError,
  type ConfigParseErrorCode,
  loadConfigFile,
  parseConfigText,
} from "./parse.js";
export {
  type AgentConfig,
  type CoreMindConfig,
  CoreMindConfigSchema,
  type CustomProviderConfig,
  type LoopConfig,
  type ModelOptionsConfig,
  type ProviderConfig,
  type ProviderRefConfig,
  type ScriptToolConfig,
  type SessionConfig,
  type ToolConfig,
  type ToolRefConfig,
  type WorkflowStep,
} from "./schema/config.js";
export {
  type PermissionsConfig,
  PermissionsConfigSchema,
  type QualityConfig,
  QualityConfigSchema,
  type RuntimeLimitsConfig,
  RuntimeLimitsSchema,
} from "./schema/harness.js";
export {
  type LoopActionConfig,
  LoopActionSchema,
  LoopConfigSchema,
  type LoopVerificationConfig,
  LoopVerificationSchema,
} from "./schema/loop.js";
export { ModelOptionsSchema } from "./schema/provider.js";
export {
  type TelemetryConfig,
  TelemetryConfigSchema,
  type TelemetryContentLevel,
  TelemetryContentLevelSchema,
  type TelemetryMode,
  TelemetryModeSchema,
} from "./schema/telemetry.js";
export {
  BUILTIN_TOOL_CAPABILITIES,
  BUILTIN_TOOL_EFFECTS,
  BUILTIN_TOOL_IDS,
  type BuiltinToolId,
  ScriptToolSchema,
  TOOL_CAPABILITY_CHECKPOINTS,
  TOOL_CAPABILITY_CONCURRENCY,
  TOOL_CAPABILITY_DURABILITY,
  TOOL_CAPABILITY_EFFECTS,
  TOOL_CAPABILITY_REPLAYS,
  TOOL_EFFECT_OPERATIONS,
  type ToolCapabilityCheckpoint,
  type ToolCapabilityConcurrency,
  type ToolCapabilityDeclaration,
  type ToolCapabilityDurability,
  type ToolCapabilityEffect,
  type ToolCapabilityReplay,
  ToolConfigSchema,
  type ToolEffectDeclaration,
  ToolEffectDeclarationSchema,
  type ToolEffectOperation,
  ToolRefSchema,
  toolEffectOperationsForCapability,
} from "./schema/tools.js";
export {
  ConfigValidationError,
  type ConfigValidationErrorCode,
  findUnknownKeys,
  parseAndValidate,
  validateConfig,
} from "./validate.js";
