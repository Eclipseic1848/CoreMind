import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ScriptToolConfig } from "coremind-config";

/** 脚本工具加载错误 */
export class ScriptToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptToolError";
  }
}

/**
 * 加载用户自定义脚本工具（JS/TS 文件，default 导出符合 AgentTool 形状的对象）。
 * 约定：
 *   export default {
 *     name: "current_time",            // 可选，缺省用配置里的 name
 *     description: "返回当前时间",
 *     parameters: Type.Object({...}),  // TypeBox schema（从 @earendil-works/pi-ai 导入 Type）
 *     execute: async (toolCallId, params, signal) => ({ content: [{ type: "text", text }], details: {} }),
 *   }
 */
export async function loadScriptTool(cfg: ScriptToolConfig, configDir: string): Promise<AgentTool> {
  const fullPath = path.resolve(configDir, cfg.path);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(fullPath).href);
  } catch (cause) {
    throw new ScriptToolError(
      `加载脚本工具 ${cfg.path} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const candidate = (mod as { default?: unknown }).default ?? mod;
  if (candidate === null || typeof candidate !== "object") {
    throw new ScriptToolError(`脚本工具 ${cfg.path} 未导出有效对象（需 export default）`);
  }
  const tool = candidate as Record<string, unknown>;
  if (typeof tool.execute !== "function") {
    throw new ScriptToolError(`脚本工具 ${cfg.path} 缺少 execute 函数`);
  }

  const name = cfg.name ?? tool.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new ScriptToolError(`脚本工具 ${cfg.path} 缺少工具名（配置 name 或导出 name 字段）`);
  }
  if (typeof tool.description !== "string" || tool.description.length === 0) {
    throw new ScriptToolError(`脚本工具 ${cfg.path} 缺少 description 描述`);
  }

  return tool as unknown as AgentTool;
}
