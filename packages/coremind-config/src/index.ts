// CoreMind 配置层：schema、解析、校验

export {
  ConfigParseError,
  loadConfigFile,
  parseConfigText,
} from "./parse.js";
export {
  type AgentConfig,
  type CoreMindConfig,
  CoreMindConfigSchema,
  type CustomProviderConfig,
  type ModelOptionsConfig,
  type ProviderConfig,
  type ProviderRefConfig,
  type ScriptToolConfig,
  type SessionConfig,
  type ToolConfig,
  type ToolRefConfig,
  type WorkflowStep,
} from "./schema/config.js";
export { ModelOptionsSchema } from "./schema/provider.js";
export {
  BUILTIN_TOOL_IDS,
  type BuiltinToolId,
  ScriptToolSchema,
  ToolConfigSchema,
  ToolRefSchema,
} from "./schema/tools.js";
export {
  ConfigValidationError,
  findUnknownKeys,
  parseAndValidate,
  validateConfig,
} from "./validate.js";
