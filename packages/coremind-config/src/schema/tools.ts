import { Type } from "@sinclair/typebox";

/** 内置工具白名单 */
export const BUILTIN_TOOL_IDS = [
  "read",
  "ls",
  "find",
  "grep",
  "git_status",
  "git_diff",
  "git_log",
  "bash",
  "edit",
  "write",
  "web-fetch",
  "web-search",
] as const;

export type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number];

export const TOOL_EFFECT_OPERATIONS = ["read", "write", "process", "network", "external"] as const;

export type ToolEffectOperation = (typeof TOOL_EFFECT_OPERATIONS)[number];

/** 自定义工具必须声明可能产生的副作用，供权限层在执行前 fail closed。 */
export const ToolEffectDeclarationSchema = Type.Object(
  {
    operations: Type.Array(
      Type.Union(TOOL_EFFECT_OPERATIONS.map((operation) => Type.Literal(operation))),
      { minItems: 1, uniqueItems: true },
    ),
    reversible: Type.Boolean({ description: "该工具的副作用是否可由框架自动回退" }),
    pathFields: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "额外的路径参数字段，支持点号路径，例如 output.path",
      }),
    ),
    urlFields: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: "额外的 URL 参数字段，支持点号路径，例如 request.endpoint",
      }),
    ),
  },
  { additionalProperties: false },
);

export interface ToolEffectDeclaration {
  operations: ToolEffectOperation[];
  reversible: boolean;
  pathFields?: string[];
  urlFields?: string[];
}

export const BUILTIN_TOOL_EFFECTS: Readonly<Record<BuiltinToolId, ToolEffectDeclaration>> = {
  read: { operations: ["read"], reversible: true },
  ls: { operations: ["read"], reversible: true },
  find: { operations: ["read"], reversible: true },
  grep: { operations: ["read"], reversible: true },
  git_status: { operations: ["read"], reversible: true },
  git_diff: { operations: ["read"], reversible: true, pathFields: ["path"] },
  git_log: { operations: ["read"], reversible: true, pathFields: ["path"] },
  edit: { operations: ["write"], reversible: true },
  write: { operations: ["write"], reversible: true },
  bash: { operations: ["process"], reversible: false },
  "web-fetch": { operations: ["network"], reversible: false },
  "web-search": { operations: ["network"], reversible: false },
};

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
  effect: ToolEffectDeclarationSchema,
});

/** 单个工具配置：内置引用或脚本工具 */
export const ToolConfigSchema = Type.Union([ToolRefSchema, ScriptToolSchema]);
