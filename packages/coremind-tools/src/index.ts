// CoreMind 工具层：内置工具注册表、网页工具、自定义脚本工具

export {
  type ArtifactImportResult,
  type ArtifactRecord,
  type ArtifactStatus,
  ArtifactStore,
  type ArtifactStoreOptions,
  extractArtifactRecord,
  redactSecrets,
  wrapToolWithArtifactCapture,
} from "./artifact-store.js";
export {
  BUILTIN_TOOL_CAPABILITIES,
  type CapabilityConstraintOrigin,
  inferLegacyToolCapability,
  isResolvedToolCapability,
  RECOVERY_DISPOSITIONS,
  type RecoveryDisposition,
  type ResolvedToolCapability,
  type ResolveToolCapabilityInput,
  recoveryDispositionFor,
  resolveToolCapability,
  TOOL_CAPABILITY_CHECKPOINTS,
  TOOL_CAPABILITY_CONCURRENCY,
  TOOL_CAPABILITY_DURABILITY,
  TOOL_CAPABILITY_EFFECTS,
  TOOL_CAPABILITY_REPLAYS,
  type ToolCapabilityCheckpoint,
  type ToolCapabilityConcurrency,
  type ToolCapabilityConstraint,
  type ToolCapabilityDeclaration,
  type ToolCapabilityDurability,
  type ToolCapabilityEffect,
  type ToolCapabilityReplay,
  type ToolCapabilityResolution,
  type ToolCapabilitySource,
} from "./capability.js";

export {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  GitAdapter,
  GitAdapterError,
  type GitAdapterErrorCode,
  type GitAdapterOptions,
  type GitDiffOptions,
  type GitLogOptions,
  type GitStatusEntry,
} from "./git-adapter.js";
export {
  createHostBashTool,
  type HostBashOptions,
  resolveWindowsShell,
} from "./host-shell.js";
export {
  buildLinuxSandboxConfig,
  createLinuxSandboxedBashTool,
  isSensitiveEnvironmentName,
  type LinuxSandboxedBashOptions,
} from "./linux-sandbox.js";
export {
  ProcessRunner,
  ProcessRunnerError,
  type ProcessRunnerErrorCode,
  type ProcessRunRequest,
  type ProcessRunResult,
} from "./process-runner.js";
export { type BuildToolsOptions, type BuildToolsResult, buildTools } from "./registry.js";
export { loadScriptTool, ScriptToolError } from "./script-tool.js";
export { ToolExecutionError } from "./tool-error.js";
export {
  createUnifiedDiff,
  DiffLimitError,
  type DiffLimitErrorCode,
  diffFiles,
  type FileDiffOptions,
  type UnifiedDiffOptions,
} from "./unified-diff.js";
export { createWebFetchTool, createWebSearchToolIfAvailable, stripHtml } from "./web-tools.js";
