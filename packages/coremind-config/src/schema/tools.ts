import { Type } from "@sinclair/typebox";

/** 内置工具白名单 */
export const BUILTIN_TOOL_IDS = [
  "read",
  "ls",
  "find",
  "grep",
  "bash",
  "edit",
  "write",
  "web-fetch",
  "web-search",
] as const;

export type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number];

/** 引用内置工具 */
export const ToolRefSchema = Type.Object({
  id: Type.Union(
    BUILTIN_TOOL_IDS.map((id) => Type.Literal(id)),
    { description: "内置工具 id" },
  ),
  enabled: Type.Optional(Type.Boolean({ default: true })),
});

/** 自定义脚本工具：指向导出 AgentTool 形状 default 对象的 JS 文件 */
export const ScriptToolSchema = Type.Object({
  path: Type.String({ minLength: 1, description: "工具文件路径（相对配置文件目录）" }),
  name: Type.Optional(Type.String({ description: "工具名，缺省取模块导出对象的 name" })),
});

/** 单个工具配置：内置引用或脚本工具 */
export const ToolConfigSchema = Type.Union([ToolRefSchema, ScriptToolSchema]);
