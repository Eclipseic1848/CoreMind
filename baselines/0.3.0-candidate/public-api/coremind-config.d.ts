import { Static } from '@sinclair/typebox';
import { TArray } from '@sinclair/typebox';
import { TBoolean } from '@sinclair/typebox';
import { TInteger } from '@sinclair/typebox';
import { TLiteral } from '@sinclair/typebox';
import { TNumber } from '@sinclair/typebox';
import { TObject } from '@sinclair/typebox';
import { TOptional } from '@sinclair/typebox';
import { TRecord } from '@sinclair/typebox';
import { TRecursive } from '@sinclair/typebox';
import { TString } from '@sinclair/typebox';
import { TThis } from '@sinclair/typebox';
import { TUnion } from '@sinclair/typebox';

export declare type AgentConfig = Static<typeof AgentConfigSchema>;

/** 单个 agent 定义 */
declare const AgentConfigSchema: TObject<    {
model: TOptional<TString>;
systemPrompt: TOptional<TString>;
tools: TOptional<TArray<TUnion<[TObject<    {
id: TUnion<TLiteral<"read" | "ls" | "find" | "grep" | "git_status" | "git_diff" | "git_log" | "bash" | "edit" | "write" | "web-fetch" | "web-search">[]>;
enabled: TOptional<TBoolean>;
}>, TObject<    {
path: TString;
name: TOptional<TString>;
effect: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
}>]>>>;
options: TOptional<TObject<    {
temperature: TOptional<TNumber>;
maxTokens: TOptional<TInteger>;
thinkingLevel: TOptional<TUnion<[TLiteral<"off">, TLiteral<"low">, TLiteral<"medium">, TLiteral<"high">, TLiteral<"xhigh">]>>;
}>>;
description: TOptional<TString>;
skills: TOptional<TArray<TString>>;
}>;

/** 唯一内置工具能力注册表；旧 effect 视图由此派生。 */
export declare const BUILTIN_TOOL_CAPABILITIES: Readonly<Record<BuiltinToolId, ToolCapabilityDeclaration>>;

export declare const BUILTIN_TOOL_EFFECTS: Readonly<Record<BuiltinToolId, ToolEffectDeclaration>>;

/** 内置工具白名单 */
export declare const BUILTIN_TOOL_IDS: readonly ["read", "ls", "find", "grep", "git_status", "git_diff", "git_log", "bash", "edit", "write", "web-fetch", "web-search"];

export declare type BuiltinToolId = (typeof BUILTIN_TOOL_IDS)[number];

/** 配置解析错误（文件读取失败或 YAML/JSON 语法错误） */
export declare class ConfigParseError extends Error {
    constructor(message: string);
}

/** 配置校验失败（含可读的中文字段路径） */
export declare class ConfigValidationError extends Error {
    /** 校验错误明细列表 */
    readonly details: readonly string[];
    constructor(message: string, details: readonly string[]);
}

export declare type CoreMindConfig = Static<typeof CoreMindConfigSchema>;

/**
 * CoreMind 配置文件顶层 schema（coremind.yaml / coremind.json）
 * 顶层只保留少量字段，全部可选字段有合理默认值，对新手友好。
 */
export declare const CoreMindConfigSchema: TObject<    {
schemaVersion: TLiteral<2>;
name: TString;
description: TOptional<TString>;
provider: TOptional<TUnion<[TObject<    {
id: TOptional<TString>;
name: TOptional<TString>;
baseUrl: TString;
model: TString;
api: TOptional<TLiteral<"openai-completions">>;
apiKey: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
headers: TOptional<TRecord<TString, TString>>;
contextWindow: TOptional<TInteger>;
maxTokens: TOptional<TInteger>;
}>, TObject<    {
id: TString;
model: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
}>]>>;
tools: TOptional<TArray<TUnion<[TObject<    {
id: TUnion<TLiteral<"read" | "ls" | "find" | "grep" | "git_status" | "git_diff" | "git_log" | "bash" | "edit" | "write" | "web-fetch" | "web-search">[]>;
enabled: TOptional<TBoolean>;
}>, TObject<    {
path: TString;
name: TOptional<TString>;
effect: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
}>]>>>;
options: TOptional<TObject<    {
temperature: TOptional<TNumber>;
maxTokens: TOptional<TInteger>;
thinkingLevel: TOptional<TUnion<[TLiteral<"off">, TLiteral<"low">, TLiteral<"medium">, TLiteral<"high">, TLiteral<"xhigh">]>>;
}>>;
agents: TRecord<TString, TObject<    {
model: TOptional<TString>;
systemPrompt: TOptional<TString>;
tools: TOptional<TArray<TUnion<[TObject<    {
id: TUnion<TLiteral<"read" | "ls" | "find" | "grep" | "git_status" | "git_diff" | "git_log" | "bash" | "edit" | "write" | "web-fetch" | "web-search">[]>;
enabled: TOptional<TBoolean>;
}>, TObject<    {
path: TString;
name: TOptional<TString>;
effect: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
}>]>>>;
options: TOptional<TObject<    {
temperature: TOptional<TNumber>;
maxTokens: TOptional<TInteger>;
thinkingLevel: TOptional<TUnion<[TLiteral<"off">, TLiteral<"low">, TLiteral<"medium">, TLiteral<"high">, TLiteral<"xhigh">]>>;
}>>;
description: TOptional<TString>;
skills: TOptional<TArray<TString>>;
}>>;
defaultAgent: TOptional<TString>;
workflow: TOptional<TArray<TRecursive<TUnion<[TObject<    {
id: TString;
type: TLiteral<"prompt">;
agent: TString;
input: TString;
saveAs: TOptional<TString>;
retry: TOptional<TObject<    {
max: TOptional<TInteger>;
if: TOptional<TString>;
}>>;
}>, TObject<    {
id: TString;
type: TLiteral<"call">;
agent: TString;
input: TString;
saveAs: TOptional<TString>;
retry: TOptional<TObject<    {
max: TOptional<TInteger>;
if: TOptional<TString>;
}>>;
}>, TObject<    {
id: TString;
type: TLiteral<"parallel">;
steps: TArray<TThis>;
saveAs: TOptional<TString>;
}>, TObject<    {
id: TString;
type: TLiteral<"if">;
condition: TString;
then: TArray<TThis>;
else: TOptional<TArray<TThis>>;
}>, TObject<    {
id: TString;
type: TLiteral<"switch">;
on: TString;
cases: TRecord<TString, TArray<TThis>>;
default: TOptional<TArray<TThis>>;
}>]>>>>;
loop: TOptional<TObject<    {
planning: TOptional<TObject<    {
agent: TString;
input: TString;
}>>;
execute: TObject<    {
agent: TString;
input: TString;
}>;
verify: TObject<    {
agent: TString;
input: TString;
passIf: TString;
evidence: TOptional<TObject<    {
mode: TLiteral<"runtime">;
regressionCommand: TString;
minSuccessfulTestCommands: TOptional<TInteger>;
requireCheckpoint: TOptional<TBoolean>;
requireDiffReview: TOptional<TBoolean>;
}>>;
}>;
repair: TObject<    {
agent: TString;
input: TString;
}>;
maxIterations: TOptional<TInteger>;
maxRepairs: TOptional<TInteger>;
maxRepeatedAction: TOptional<TInteger>;
onFailure: TOptional<TUnion<[TLiteral<"repair">, TLiteral<"pause">, TLiteral<"fail">]>>;
onExhausted: TOptional<TUnion<[TLiteral<"pause">, TLiteral<"fail">]>>;
}>>;
session: TOptional<TObject<    {
enabled: TBoolean;
dir: TOptional<TString>;
compact: TOptional<TBoolean>;
}>>;
runtime: TOptional<TObject<    {
maxTurns: TOptional<TInteger>;
maxSteps: TOptional<TInteger>;
stepTimeoutMs: TOptional<TInteger>;
runTimeoutMs: TOptional<TInteger>;
maxToolCalls: TOptional<TInteger>;
maxToolFailures: TOptional<TInteger>;
maxRetries: TOptional<TInteger>;
maxTokens: TOptional<TInteger>;
maxCostUsd: TOptional<TNumber>;
}>>;
permissions: TOptional<TObject<    {
mode: TOptional<TUnion<[TLiteral<"ask">, TLiteral<"assisted">, TLiteral<"full">]>>;
workspaceOnly: TOptional<TBoolean>;
network: TOptional<TUnion<[TLiteral<"ask">, TLiteral<"allow">, TLiteral<"deny">]>>;
allow: TOptional<TArray<TString>>;
deny: TOptional<TArray<TString>>;
}>>;
quality: TOptional<TObject<    {
profile: TOptional<TUnion<[TLiteral<"development">, TLiteral<"standard">, TLiteral<"strict">]>>;
allowOverride: TOptional<TBoolean>;
minScenarioPassRate: TOptional<TNumber>;
}>>;
telemetry: TOptional<TObject<    {
mode: TOptional<TUnion<[TLiteral<"DISABLED">, TLiteral<"FEEDBACK_ONLY">, TLiteral<"FULL">]>>;
endpoint: TOptional<TString>;
contentLevel: TOptional<TUnion<[TLiteral<"metrics_only">, TLiteral<"content">]>>;
allowedFields: TOptional<TArray<TString>>;
}>>;
}>;

export declare type CustomProviderConfig = Static<typeof CustomProviderSchema>;

/** 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关 / 私有部署） */
declare const CustomProviderSchema: TObject<    {
id: TOptional<TString>;
name: TOptional<TString>;
baseUrl: TString;
model: TString;
api: TOptional<TLiteral<"openai-completions">>;
apiKey: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
headers: TOptional<TRecord<TString, TString>>;
contextWindow: TOptional<TInteger>;
maxTokens: TOptional<TInteger>;
}>;

/**
 * 检查顶层与 agents 级别是否存在未知字段（额外字段），
 * 供调用方以告警形式提示（不阻断执行，对新手友好）。
 */
export declare function findUnknownKeys(data: unknown): string[];

/** 读取并解析配置文件（.yaml/.yml/.json 均支持） */
export declare function loadConfigFile(filePath: string): Promise<unknown>;

export declare type LoopActionConfig = Static<typeof LoopActionSchema>;

/** Loop 中一次由 Agent 执行的有界动作。 */
export declare const LoopActionSchema: TObject<    {
agent: TString;
input: TString;
}>;

export declare type LoopConfig = Static<typeof LoopConfigSchema>;

/** 显式验证—修复 Loop；状态机实现属于 Runtime 内部细节。 */
export declare const LoopConfigSchema: TObject<    {
planning: TOptional<TObject<    {
agent: TString;
input: TString;
}>>;
execute: TObject<    {
agent: TString;
input: TString;
}>;
verify: TObject<    {
agent: TString;
input: TString;
passIf: TString;
evidence: TOptional<TObject<    {
mode: TLiteral<"runtime">;
regressionCommand: TString;
minSuccessfulTestCommands: TOptional<TInteger>;
requireCheckpoint: TOptional<TBoolean>;
requireDiffReview: TOptional<TBoolean>;
}>>;
}>;
repair: TObject<    {
agent: TString;
input: TString;
}>;
maxIterations: TOptional<TInteger>;
maxRepairs: TOptional<TInteger>;
maxRepeatedAction: TOptional<TInteger>;
onFailure: TOptional<TUnion<[TLiteral<"repair">, TLiteral<"pause">, TLiteral<"fail">]>>;
onExhausted: TOptional<TUnion<[TLiteral<"pause">, TLiteral<"fail">]>>;
}>;

export declare type LoopVerificationConfig = Static<typeof LoopVerificationSchema>;

/** 验证动作以 passIf 明确决定是否完成，不能只依赖流畅的最终文字。 */
export declare const LoopVerificationSchema: TObject<    {
agent: TString;
input: TString;
passIf: TString;
evidence: TOptional<TObject<    {
mode: TLiteral<"runtime">;
regressionCommand: TString;
minSuccessfulTestCommands: TOptional<TInteger>;
requireCheckpoint: TOptional<TBoolean>;
requireDiffReview: TOptional<TBoolean>;
}>>;
}>;

export declare type ModelOptionsConfig = Static<typeof ModelOptionsSchema>;

/** 模型选项（temperature / maxTokens / thinkingLevel） */
export declare const ModelOptionsSchema: TObject<    {
temperature: TOptional<TNumber>;
maxTokens: TOptional<TInteger>;
thinkingLevel: TOptional<TUnion<[TLiteral<"off">, TLiteral<"low">, TLiteral<"medium">, TLiteral<"high">, TLiteral<"xhigh">]>>;
}>;

/** 便捷入口：解析 + 校验 + 未知字段告警，一次完成 */
export declare function parseAndValidate(data: unknown): {
    config: CoreMindConfig;
    warnings: string[];
};

/** 从 YAML/JSON 文本解析配置（YAML 是 JSON 超集，同一解析路径） */
export declare function parseConfigText(text: string, sourceName?: string): unknown;

export declare type PermissionsConfig = Static<typeof PermissionsConfigSchema>;

/** 工具执行权限：用户决定授权强度，审计与 checkpoint 始终启用。 */
export declare const PermissionsConfigSchema: TObject<    {
mode: TOptional<TUnion<[TLiteral<"ask">, TLiteral<"assisted">, TLiteral<"full">]>>;
workspaceOnly: TOptional<TBoolean>;
network: TOptional<TUnion<[TLiteral<"ask">, TLiteral<"allow">, TLiteral<"deny">]>>;
allow: TOptional<TArray<TString>>;
deny: TOptional<TArray<TString>>;
}>;

export declare type ProviderConfig = Static<typeof ProviderSchema>;

export declare type ProviderRefConfig = Static<typeof ProviderRefSchema>;

/** 内置 provider 引用：只写 id，apiKey 默认按 id 推断环境变量名 */
declare const ProviderRefSchema: TObject<    {
id: TString;
model: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
}>;

/**
 * provider 字段：内置引用或自定义端点，缺省为 deepseek。
 * 注意：自定义端点（含 baseUrl 判别字段）必须放在 Union 首位，
 * 否则宽松的内置引用会先命中并吞掉 baseUrl 等字段。
 */
declare const ProviderSchema: TUnion<[TObject<    {
id: TOptional<TString>;
name: TOptional<TString>;
baseUrl: TString;
model: TString;
api: TOptional<TLiteral<"openai-completions">>;
apiKey: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
headers: TOptional<TRecord<TString, TString>>;
contextWindow: TOptional<TInteger>;
maxTokens: TOptional<TInteger>;
}>, TObject<    {
id: TString;
model: TOptional<TString>;
apiKeyEnv: TOptional<TString>;
}>]>;

export declare type QualityConfig = Static<typeof QualityConfigSchema>;

/** 质量门禁预设；业务阈值由用户项目自行配置和确认。 */
export declare const QualityConfigSchema: TObject<    {
profile: TOptional<TUnion<[TLiteral<"development">, TLiteral<"standard">, TLiteral<"strict">]>>;
allowOverride: TOptional<TBoolean>;
minScenarioPassRate: TOptional<TNumber>;
}>;

export declare type RuntimeLimitsConfig = Static<typeof RuntimeLimitsSchema>;

/** 单次运行的多维预算，防止 Agent/Workflow 无边界执行。 */
export declare const RuntimeLimitsSchema: TObject<    {
maxTurns: TOptional<TInteger>;
maxSteps: TOptional<TInteger>;
stepTimeoutMs: TOptional<TInteger>;
runTimeoutMs: TOptional<TInteger>;
maxToolCalls: TOptional<TInteger>;
maxToolFailures: TOptional<TInteger>;
maxRetries: TOptional<TInteger>;
maxTokens: TOptional<TInteger>;
maxCostUsd: TOptional<TNumber>;
}>;

export declare type ScriptToolConfig = Static<typeof ScriptToolSchema>;

/** 自定义脚本工具：指向导出 AgentTool 形状 default 对象的 JS 文件 */
export declare const ScriptToolSchema: TObject<    {
path: TString;
name: TOptional<TString>;
effect: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
}>;

export declare type SessionConfig = Static<typeof SessionConfigSchema>;

/** 会话配置（持久化开关） */
declare const SessionConfigSchema: TObject<    {
enabled: TBoolean;
dir: TOptional<TString>;
compact: TOptional<TBoolean>;
}>;

export declare type TelemetryConfig = Static<typeof TelemetryConfigSchema>;

/** 本地观测始终开启；这里只配置可选的进程外投影通道。 */
export declare const TelemetryConfigSchema: TObject<    {
mode: TOptional<TUnion<[TLiteral<"DISABLED">, TLiteral<"FEEDBACK_ONLY">, TLiteral<"FULL">]>>;
endpoint: TOptional<TString>;
contentLevel: TOptional<TUnion<[TLiteral<"metrics_only">, TLiteral<"content">]>>;
allowedFields: TOptional<TArray<TString>>;
}>;

export declare type TelemetryContentLevel = Static<typeof TelemetryContentLevelSchema>;

export declare const TelemetryContentLevelSchema: TUnion<[TLiteral<"metrics_only">, TLiteral<"content">]>;

export declare type TelemetryMode = Static<typeof TelemetryModeSchema>;

export declare const TelemetryModeSchema: TUnion<[TLiteral<"DISABLED">, TLiteral<"FEEDBACK_ONLY">, TLiteral<"FULL">]>;

export declare const TOOL_CAPABILITY_CHECKPOINTS: readonly ["none", "required", "unsupported"];

export declare const TOOL_CAPABILITY_CONCURRENCY: readonly ["parallel", "run_serial", "workspace_exclusive"];

export declare const TOOL_CAPABILITY_DURABILITY: readonly ["ordinary", "critical"];

export declare const TOOL_CAPABILITY_EFFECTS: readonly ["none", "workspace", "process", "network", "external", "unknown"];

export declare const TOOL_CAPABILITY_REPLAYS: readonly ["safe", "idempotent", "unsafe", "unknown"];

export declare const TOOL_EFFECT_OPERATIONS: readonly ["read", "write", "process", "network", "external"];

export declare type ToolCapabilityCheckpoint = (typeof TOOL_CAPABILITY_CHECKPOINTS)[number];

export declare type ToolCapabilityConcurrency = (typeof TOOL_CAPABILITY_CONCURRENCY)[number];

export declare interface ToolCapabilityDeclaration {
    effect: ToolCapabilityEffect;
    replay: ToolCapabilityReplay;
    concurrency: ToolCapabilityConcurrency;
    checkpoint: ToolCapabilityCheckpoint;
    durability: ToolCapabilityDurability;
}

export declare type ToolCapabilityDurability = (typeof TOOL_CAPABILITY_DURABILITY)[number];

export declare type ToolCapabilityEffect = (typeof TOOL_CAPABILITY_EFFECTS)[number];

export declare type ToolCapabilityReplay = (typeof TOOL_CAPABILITY_REPLAYS)[number];

export declare type ToolConfig = Static<typeof ToolConfigSchema>;

/** 单个工具配置：内置引用或脚本工具 */
export declare const ToolConfigSchema: TUnion<[TObject<    {
id: TUnion<TLiteral<"read" | "ls" | "find" | "grep" | "git_status" | "git_diff" | "git_log" | "bash" | "edit" | "write" | "web-fetch" | "web-search">[]>;
enabled: TOptional<TBoolean>;
}>, TObject<    {
path: TString;
name: TOptional<TString>;
effect: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;
}>]>;

export declare interface ToolEffectDeclaration {
    operations: ToolEffectOperation[];
    reversible: boolean;
    pathFields?: string[];
    urlFields?: string[];
}

/** 自定义工具必须声明可能产生的副作用，供权限层在执行前 fail closed。 */
export declare const ToolEffectDeclarationSchema: TObject<    {
operations: TArray<TUnion<TLiteral<"read" | "write" | "process" | "network" | "external">[]>>;
reversible: TBoolean;
pathFields: TOptional<TArray<TString>>;
urlFields: TOptional<TArray<TString>>;
}>;

export declare type ToolEffectOperation = (typeof TOOL_EFFECT_OPERATIONS)[number];

/** 将规范化 Capability effect 投影为 0.3.x 兼容 ToolEffect operations。 */
export declare function toolEffectOperationsForCapability(effect: ToolCapabilityEffect): ToolEffectOperation[];

export declare type ToolRefConfig = Static<typeof ToolRefSchema>;

/** 引用内置工具 */
export declare const ToolRefSchema: TObject<    {
id: TUnion<TLiteral<"read" | "ls" | "find" | "grep" | "git_status" | "git_diff" | "git_log" | "bash" | "edit" | "write" | "web-fetch" | "web-search">[]>;
enabled: TOptional<TBoolean>;
}>;

/** 校验配置并填充默认值；结构错误抛 ConfigValidationError（中文可读） */
export declare function validateConfig(data: unknown): CoreMindConfig;

export declare type WorkflowStep = Static<typeof WorkflowStepSchema>;

/**
 * 工作流步骤（简化编排，不做 DAG/循环）：
 * - prompt  / call   ：派发任务给某 agent（call 语义为委托，输入进其会话）
 * - parallel          ：并行执行子步骤
 * - if / switch       ：条件分支（条件仅支持 ==、!=、contains 与真值判定）
 * 支持嵌套（parallel/if/switch 内部可再含步骤），运行时以深度护栏限制。
 */
declare const WorkflowStepSchema: TRecursive<TUnion<[TObject<    {
id: TString;
type: TLiteral<"prompt">;
agent: TString;
input: TString;
saveAs: TOptional<TString>;
retry: TOptional<TObject<    {
max: TOptional<TInteger>;
if: TOptional<TString>;
}>>;
}>, TObject<    {
id: TString;
type: TLiteral<"call">;
agent: TString;
input: TString;
saveAs: TOptional<TString>;
retry: TOptional<TObject<    {
max: TOptional<TInteger>;
if: TOptional<TString>;
}>>;
}>, TObject<    {
id: TString;
type: TLiteral<"parallel">;
steps: TArray<TThis>;
saveAs: TOptional<TString>;
}>, TObject<    {
id: TString;
type: TLiteral<"if">;
condition: TString;
then: TArray<TThis>;
else: TOptional<TArray<TThis>>;
}>, TObject<    {
id: TString;
type: TLiteral<"switch">;
on: TString;
cases: TRecord<TString, TArray<TThis>>;
default: TOptional<TArray<TThis>>;
}>]>>;

export { }
