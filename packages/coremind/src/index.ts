// CoreMind（星枢智核）统一入口 —— 聚合门面，只 re-export，不写业务逻辑

export {
  type AgentConfig,
  type CoreMindConfig,
  loadConfigFile,
  parseAndValidate,
  parseConfigText,
  validateConfig,
  type WorkflowStep,
} from "coremind-config";
export {
  buildAgentFromConfig,
  CoreMindError,
  type CoreMindEvent,
  CoreMindRuntime,
  type CoreMindRuntimeOptions,
  type RunResult,
  type StepOutput,
} from "coremind-runtime";

export { type BuildToolsOptions, buildTools } from "coremind-tools";
