import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { BuiltinToolId, ToolConfig } from "coremind-config";
import { loadScriptTool } from "./script-tool.js";
import { createWebFetchTool, createWebSearchToolIfAvailable } from "./web-tools.js";

/** 内置工具工厂：id → 构造器（返回 null 表示需要额外配置而跳过） */
const BUILTIN_FACTORIES: Record<
  BuiltinToolId,
  (cwd: string, env: NodeJS.ProcessEnv) => AgentTool | null
> = {
  read: (cwd) => createReadTool(cwd),
  ls: (cwd) => createLsTool(cwd),
  find: (cwd) => createFindTool(cwd),
  grep: (cwd) => createGrepTool(cwd),
  bash: (cwd) => createBashTool(cwd),
  edit: (cwd) => createEditTool(cwd),
  write: (cwd) => createWriteTool(cwd),
  "web-fetch": () => createWebFetchTool(),
  "web-search": (_, env) => createWebSearchToolIfAvailable(env),
};

export interface BuildToolsOptions {
  /** 工作目录（传给文件类工具） */
  cwd: string;
  /** 配置文件所在目录（解析脚本工具相对路径用） */
  configDir: string;
  /** 环境变量（默认 process.env），测试可注入 */
  env?: NodeJS.ProcessEnv;
}

export interface BuildToolsResult {
  tools: AgentTool[];
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
  const env = opts.env ?? process.env;
  const tools: AgentTool[] = [];
  const warnings: string[] = [];

  for (const cfg of configs) {
    if ("path" in cfg) {
      try {
        tools.push(await loadScriptTool(cfg, opts.configDir));
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
    const tool = factory(opts.cwd, env);
    if (!tool) {
      warnings.push(`工具 ${cfg.id} 需要额外配置（如 API key），已跳过`);
      continue;
    }
    tools.push(tool);
  }

  return { tools, warnings };
}
