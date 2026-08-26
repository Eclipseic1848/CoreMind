import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  BUILTIN_TOOL_EFFECTS,
  type BuiltinToolId,
  type ToolConfig,
  type ToolEffectDeclaration,
} from "coremind-config";
import { ArtifactStore, wrapToolWithArtifactCapture } from "./artifact-store.js";
import {
  inferLegacyToolCapability,
  type ResolvedToolCapability,
  resolveToolCapability,
} from "./capability.js";
import type { ExecutionEnvironment } from "./execution-environment.js";
import {
  createGitDiffToolWithRunner,
  createGitLogToolWithRunner,
  createGitStatusToolWithRunner,
} from "./git-adapter.js";
import { createHostBashToolForEnvironment } from "./host-shell.js";
import { createLinuxSandboxedBashToolForEnvironment } from "./linux-sandbox.js";
import { createSupervisedProcessRunner } from "./process-runner.js";
import { loadScriptTool } from "./script-tool.js";
import {
  createWebFetchToolForEnvironment,
  createWebSearchToolForEnvironment,
} from "./web-tools.js";

/** 内置工具工厂：id → 构造器（返回 null 表示需要额外配置而跳过） */
const BUILTIN_FACTORIES: Record<
  BuiltinToolId,
  (
    cwd: string,
    env: NodeJS.ProcessEnv,
    executionEnvironment?: ExecutionEnvironment,
  ) => AgentTool | null
> = {
  read: (cwd) => createReadTool(cwd),
  ls: (cwd) => createLsTool(cwd),
  find: (cwd) => createFindTool(cwd),
  grep: (cwd) => createGrepTool(cwd),
  git_status: (cwd, _env, executionEnvironment) =>
    createGitStatusToolWithRunner(cwd, createSupervisedProcessRunner(executionEnvironment)),
  git_diff: (cwd, _env, executionEnvironment) =>
    createGitDiffToolWithRunner(cwd, createSupervisedProcessRunner(executionEnvironment)),
  git_log: (cwd, _env, executionEnvironment) =>
    createGitLogToolWithRunner(cwd, createSupervisedProcessRunner(executionEnvironment)),
  bash: (cwd, env, executionEnvironment) =>
    process.platform === "linux"
      ? createLinuxSandboxedBashToolForEnvironment({ cwd, env }, executionEnvironment)
      : createHostBashToolForEnvironment({ cwd, env }, executionEnvironment),
  edit: (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  "web-fetch": (_cwd, _env, executionEnvironment) =>
    createWebFetchToolForEnvironment(executionEnvironment),
  "web-search": (_cwd, env, executionEnvironment) =>
    createWebSearchToolForEnvironment(env, executionEnvironment),
};

/** 单个 agent 工具数量建议上限（工具过多会降低模型工具选择准确率，参考主流生产经验 0-20） */
export const MAX_TOOLS_PER_AGENT = 20;

export interface BuildToolsOptions {
  /** 工作目录（传给文件类工具） */
  cwd: string;
  /** 配置文件所在目录（解析脚本工具相对路径用） */
  configDir: string;
  /** 环境变量（默认 process.env），测试可注入 */
  env?: NodeJS.ProcessEnv;
  /** 受控工具输出存储；缺省使用工作区 .coremind/artifacts。 */
  artifactStore?: ArtifactStore;
}

export interface BuildToolsResult {
  tools: AgentTool[];
  effects: Map<string, ToolEffectDeclaration>;
  capabilities: Map<string, ResolvedToolCapability>;
  warnings: string[];
}

/**
 * 按配置构建工具列表：
 * - 内置工具按 id 查工厂；enabled: false 跳过
 * - 需要额外配置的工具（如 web-search 无 key）跳过并告警
 * - 脚本工具异步加载
 */
export async function buildTools(
  configs: ToolConfig[],
  opts: BuildToolsOptions,
): Promise<BuildToolsResult> {
  return buildToolsWithExecutionEnvironment(configs, opts);
}

export async function buildToolsWithExecutionEnvironment(
  configs: ToolConfig[],
  opts: BuildToolsOptions,
  executionEnvironment?: ExecutionEnvironment,
): Promise<BuildToolsResult> {
  const env = opts.env ?? process.env;
  const tools: AgentTool[] = [];
  const effects = new Map<string, ToolEffectDeclaration>();
  const capabilities = new Map<string, ResolvedToolCapability>();
  const warnings: string[] = [];
  const artifactStore = opts.artifactStore ?? new ArtifactStore({ cwd: opts.cwd });

  for (const cfg of configs) {
    if ("path" in cfg) {
      try {
        const tool = await loadScriptTool(cfg, opts.configDir);
        if (Object.hasOwn(BUILTIN_TOOL_EFFECTS, tool.name)) {
          warnings.push(`脚本工具 ${tool.name} 不得使用内置工具名，已跳过`);
          continue;
        }
        tools.push(wrapToolWithArtifactCapture(tool, artifactStore));
        effects.set(tool.name, cfg.effect);
        capabilities.set(tool.name, inferLegacyToolCapability(tool.name, cfg.effect));
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
      continue;
    }

    if (cfg.enabled === false) continue;
    const factory = BUILTIN_FACTORIES[cfg.id];
    if (!factory) {
      warnings.push(`内置工具 ${cfg.id} 不存在，已跳过`);
      continue;
    }
    const tool = factory(opts.cwd, env, executionEnvironment);
    if (!tool) {
      warnings.push(`工具 ${cfg.id} 需要额外配置（如 API key），已跳过`);
      continue;
    }
    tools.push(wrapToolWithArtifactCapture(tool, artifactStore));
    effects.set(tool.name, BUILTIN_TOOL_EFFECTS[cfg.id]);
    capabilities.set(tool.name, resolveToolCapability({ tool: tool.name }));
  }

  // 规模护栏：工具过多会退化模型选择准确率（Shopify 生产经验：0-20 清晰、50+ 难推理）
  if (tools.length > MAX_TOOLS_PER_AGENT) {
    warnings.push(
      `工具数量 ${tools.length} 超过建议上限 ${MAX_TOOLS_PER_AGENT}（工具过多会降低模型工具选择准确率），请精简`,
    );
  }

  return { tools, effects, capabilities, warnings };
}
