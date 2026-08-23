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

export const TOOL_CAPABILITY_EFFECTS = [
  "none",
  "workspace",
  "process",
  "network",
  "external",
  "unknown",
] as const;
export const TOOL_CAPABILITY_REPLAYS = ["safe", "idempotent", "unsafe", "unknown"] as const;
export const TOOL_CAPABILITY_CONCURRENCY = [
  "parallel",
  "run_serial",
  "workspace_exclusive",
] as const;
export const TOOL_CAPABILITY_CHECKPOINTS = ["none", "required", "unsupported"] as const;
export const TOOL_CAPABILITY_DURABILITY = ["ordinary", "critical"] as const;

export type ToolCapabilityEffect = (typeof TOOL_CAPABILITY_EFFECTS)[number];
export type ToolCapabilityReplay = (typeof TOOL_CAPABILITY_REPLAYS)[number];
export type ToolCapabilityConcurrency = (typeof TOOL_CAPABILITY_CONCURRENCY)[number];
export type ToolCapabilityCheckpoint = (typeof TOOL_CAPABILITY_CHECKPOINTS)[number];
export type ToolCapabilityDurability = (typeof TOOL_CAPABILITY_DURABILITY)[number];

export interface ToolCapabilityDeclaration {
  effect: ToolCapabilityEffect;
  replay: ToolCapabilityReplay;
  concurrency: ToolCapabilityConcurrency;
  checkpoint: ToolCapabilityCheckpoint;
  durability: ToolCapabilityDurability;
}

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

interface BuiltinToolMetadata {
  capability: ToolCapabilityDeclaration;
  pathFields?: string[];
  urlFields?: string[];
}

const PURE_LOCAL_READ: ToolCapabilityDeclaration = {
  effect: "none",
  replay: "safe",
  concurrency: "parallel",
  checkpoint: "none",
  durability: "ordinary",
};
const WORKSPACE_WRITE: ToolCapabilityDeclaration = {
  effect: "workspace",
  replay: "idempotent",
  concurrency: "workspace_exclusive",
  checkpoint: "required",
  durability: "critical",
};
const BUILTIN_TOOL_METADATA: Readonly<Record<BuiltinToolId, BuiltinToolMetadata>> = {
  read: { capability: PURE_LOCAL_READ },
  ls: { capability: PURE_LOCAL_READ },
  find: { capability: PURE_LOCAL_READ },
  grep: { capability: PURE_LOCAL_READ },
  git_status: { capability: PURE_LOCAL_READ },
  git_diff: { capability: PURE_LOCAL_READ, pathFields: ["path"] },
  git_log: { capability: PURE_LOCAL_READ, pathFields: ["path"] },
  edit: { capability: WORKSPACE_WRITE },
  write: { capability: WORKSPACE_WRITE },
  bash: {
    capability: {
      effect: "process",
      replay: "unknown",
      concurrency: "run_serial",
      checkpoint: "unsupported",
      durability: "critical",
    },
  },
  "web-fetch": {
    capability: {
      effect: "network",
      replay: "unknown",
      concurrency: "run_serial",
      checkpoint: "none",
      durability: "critical",
    },
  },
  "web-search": {
    capability: {
      effect: "network",
      replay: "unknown",
      concurrency: "run_serial",
      checkpoint: "none",
      durability: "critical",
    },
  },
};

/** 唯一内置工具能力注册表；旧 effect 视图由此派生。 */
export const BUILTIN_TOOL_CAPABILITIES: Readonly<Record<BuiltinToolId, ToolCapabilityDeclaration>> =
  Object.freeze(
    Object.fromEntries(
      BUILTIN_TOOL_IDS.map((id) => [id, Object.freeze(BUILTIN_TOOL_METADATA[id].capability)]),
    ) as Record<BuiltinToolId, ToolCapabilityDeclaration>,
  );

export const BUILTIN_TOOL_EFFECTS: Readonly<Record<BuiltinToolId, ToolEffectDeclaration>> =
  Object.freeze(
    Object.fromEntries(
      BUILTIN_TOOL_IDS.map((id) => {
        const metadata = BUILTIN_TOOL_METADATA[id];
        return [
          id,
          Object.freeze({
            operations: Object.freeze(
              toolEffectOperationsForCapability(metadata.capability.effect),
            ) as unknown as ToolEffectOperation[],
            reversible:
              metadata.capability.replay === "safe" || metadata.capability.replay === "idempotent",
            ...(metadata.pathFields
              ? { pathFields: Object.freeze([...metadata.pathFields]) as unknown as string[] }
              : {}),
            ...(metadata.urlFields
              ? { urlFields: Object.freeze([...metadata.urlFields]) as unknown as string[] }
              : {}),
          }),
        ];
      }),
    ) as Record<BuiltinToolId, ToolEffectDeclaration>,
  );

/** 将规范化 Capability effect 投影为 0.3.x 兼容 ToolEffect operations。 */
export function toolEffectOperationsForCapability(
  effect: ToolCapabilityEffect,
): ToolEffectOperation[] {
  switch (effect) {
    case "none":
      return ["read"];
    case "workspace":
      return ["write"];
    case "process":
      return ["process"];
    case "network":
      return ["network"];
    case "external":
    case "unknown":
      return ["external"];
  }
}

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
