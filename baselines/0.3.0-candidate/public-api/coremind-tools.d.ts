import type { AgentTool } from '@earendil-works/pi-agent-core';
import { BUILTIN_TOOL_CAPABILITIES } from 'coremind-config';
import { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import type { ScriptToolConfig } from 'coremind-config';
import { TOOL_CAPABILITY_CHECKPOINTS } from 'coremind-config';
import { TOOL_CAPABILITY_CONCURRENCY } from 'coremind-config';
import { TOOL_CAPABILITY_DURABILITY } from 'coremind-config';
import { TOOL_CAPABILITY_EFFECTS } from 'coremind-config';
import { TOOL_CAPABILITY_REPLAYS } from 'coremind-config';
import { ToolCapabilityCheckpoint } from 'coremind-config';
import { ToolCapabilityConcurrency } from 'coremind-config';
import { ToolCapabilityDeclaration } from 'coremind-config';
import { ToolCapabilityDurability } from 'coremind-config';
import { ToolCapabilityEffect } from 'coremind-config';
import { ToolCapabilityReplay } from 'coremind-config';
import { ToolConfig } from 'coremind-config';
import { ToolEffectDeclaration } from 'coremind-config';
import { Type } from '@earendil-works/pi-ai';

export declare interface ArtifactImportResult {
    record: ArtifactRecord;
    preview: string;
}

export declare interface ArtifactRecord {
    artifactId: string;
    status: ArtifactStatus;
    relativePath?: string;
    sizeBytes: number;
    sha256?: string;
    mediaType: string;
    createdAt: string;
    retention: "run";
    redaction: "none" | "blocked-secret";
}

export declare type ArtifactStatus = "stored" | "blocked";

/**
 * 把完整工具输出保存在工作区受控目录；模型只读取固定大小的头尾预览。
 * Artifact 文件名由框架生成，调用方不能借此写入任意路径。
 */
export declare class ArtifactStore {
    private readonly cwd;
    private readonly rootDir;
    private readonly idFactory;
    private readonly now;
    private readonly previewBytes;
    constructor(options: ArtifactStoreOptions);
    importFile(sourcePath: string, options?: {
        deleteSource?: boolean;
        mediaType?: string;
    }): Promise<ArtifactImportResult>;
    /** 只清理受控目录内、超过指定保留时间的框架生成日志。 */
    cleanup(olderThanMs: number): Promise<number>;
    private ensureRoot;
    private buildPreview;
}

export declare interface ArtifactStoreOptions {
    cwd: string;
    rootDir?: string;
    idFactory?: () => string;
    now?: () => Date;
    previewBytes?: number;
}

/** 默认拒绝网络和凭据，只允许写工作区；权限审批与 sandbox 是两条独立防线。 */
export declare function buildLinuxSandboxConfig(cwd: string, env: NodeJS.ProcessEnv): SandboxRuntimeConfig;

/**
 * 按配置构建工具列表：
 * - 内置工具按 id 查工厂；enabled: false 跳过
 * - 需要额外配置的工具（如 web-search 无 key）跳过并告警
 * - 脚本工具异步加载
 */
export declare function buildTools(configs: ToolConfig[], opts: BuildToolsOptions): Promise<BuildToolsResult>;

export declare interface BuildToolsOptions {
    /** 工作目录（传给文件类工具） */
    cwd: string;
    /** 配置文件所在目录（解析脚本工具相对路径用） */
    configDir: string;
    /** 环境变量（默认 process.env），测试可注入 */
    env?: NodeJS.ProcessEnv;
    /** 受控工具输出存储；缺省使用工作区 .coremind/artifacts。 */
    artifactStore?: ArtifactStore;
}

export declare interface BuildToolsResult {
    tools: AgentTool[];
    effects: Map<string, ToolEffectDeclaration>;
    capabilities: Map<string, ResolvedToolCapability>;
    warnings: string[];
}

export { BUILTIN_TOOL_CAPABILITIES }

export declare type CapabilityConstraintOrigin = "config" | "extension" | "host" | "entrypoint";

export declare function createGitDiffTool(cwd: string): AgentTool<typeof GitDiffParams>;

export declare function createGitLogTool(cwd: string): AgentTool<typeof GitLogParams>;

export declare function createGitStatusTool(cwd: string): AgentTool<typeof GitStatusParams>;

/** 非 Linux 宿主命令统一走 ProcessRunner；权限层仍在执行前决定是否允许。 */
export declare function createHostBashTool(options: HostBashOptions): AgentTool;

/** Linux bash 使用真实 OS 隔离；初始化或依赖缺失时失败关闭，不回退到宿主 shell。 */
export declare function createLinuxSandboxedBashTool(options: LinuxSandboxedBashOptions): AgentTool;

/** 为 UTF-8 文本生成标准 unified diff，并对输入、复杂度和输出分别限流。 */
export declare function createUnifiedDiff(before: string, after: string, options?: UnifiedDiffOptions): string;

/**
 * web-fetch 工具：抓取网页并转为纯文本（去掉 HTML 标签），
 * 适合让模型读取公开网页信息。基于 Node 原生 fetch，零额外依赖。
 */
export declare function createWebFetchTool(): AgentTool<typeof WebFetchParams>;

/**
 * web-search 工具（可选）：需要 TAVILY_API_KEY 环境变量。
 * 未配置 key 时返回 null，由注册表跳过并告警——避免给模型一个永远失败的工具。
 */
export declare function createWebSearchToolIfAvailable(env?: NodeJS.ProcessEnv): AgentTool<typeof WebSearchParams> | null;

/** 对两个工作区普通文件使用同一 diff 实现；路径解析包含目录链接逃逸检查。 */
export declare function diffFiles(options: FileDiffOptions): Promise<string>;

export declare class DiffLimitError extends Error {
    readonly code: DiffLimitErrorCode;
    constructor(code: DiffLimitErrorCode, message: string);
}

export declare type DiffLimitErrorCode = "diff_complexity_limit" | "diff_input_limit" | "diff_output_limit" | "diff_path_outside_workspace";

export declare function extractArtifactRecord(details: unknown): ArtifactRecord | undefined;

export declare interface FileDiffOptions extends UnifiedDiffOptions {
    cwd: string;
    beforePath: string;
    afterPath: string;
}

/** 只暴露固定 Git 读命令，不接受任意子命令或任意参数。 */
export declare class GitAdapter {
    private readonly options;
    private readonly runner;
    private readonly maxOutputBytes;
    constructor(options: GitAdapterOptions);
    status(signal?: AbortSignal): Promise<string>;
    statusEntries(signal?: AbortSignal): Promise<GitStatusEntry[]>;
    diff(options?: GitDiffOptions): Promise<string>;
    log(options?: GitLogOptions): Promise<string>;
    private execute;
    private safePath;
}

export declare class GitAdapterError extends Error {
    readonly code: GitAdapterErrorCode;
    constructor(code: GitAdapterErrorCode, message: string, options?: {
        cause?: unknown;
    });
}

export declare type GitAdapterErrorCode = "git_command_failed" | "git_invalid_request" | "git_path_outside_workspace";

export declare interface GitAdapterOptions {
    cwd: string;
    runner?: ProcessRunner;
    maxOutputBytes?: number;
}

export declare interface GitDiffOptions {
    path?: string;
    staged?: boolean;
    signal?: AbortSignal;
}

declare const GitDiffParams: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    staged: Type.TOptional<Type.TBoolean>;
}>;

export declare interface GitLogOptions {
    path?: string;
    limit?: number;
    signal?: AbortSignal;
}

declare const GitLogParams: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
}>;

export declare interface GitStatusEntry {
    index: string;
    worktree: string;
    path: string;
    originalPath?: string;
}

declare const GitStatusParams: Type.TObject<{}>;

export declare interface HostBashOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
}

/** 供 0.3.x 旧 effect 调用方与 Runtime 注册兼容；新集成应直接声明完整 Capability。 */
export declare function inferLegacyToolCapability(tool: string, declaration: ToolEffectDeclaration): ResolvedToolCapability;

/** 在 JavaScript、RunState 与插件等非类型安全边界验证完整且自洽的解析结果。 */
export declare function isResolvedToolCapability(value: unknown, expectedTool?: string): value is ResolvedToolCapability;

export declare function isSensitiveEnvironmentName(name: string): boolean;

export declare interface LinuxSandboxedBashOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
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
export declare function loadScriptTool(cfg: ScriptToolConfig, configDir: string): Promise<AgentTool>;

/** 使用无 shell 的参数数组执行进程；需要 shell 语义时由上层显式选择解释器。 */
export declare class ProcessRunner {
    run(request: ProcessRunRequest): Promise<ProcessRunResult>;
}

/** 统一暴露超时、取消、输出上限和启动失败，不把依赖库错误形状泄漏给调用方。 */
export declare class ProcessRunnerError extends Error {
    readonly code: ProcessRunnerErrorCode;
    constructor(code: ProcessRunnerErrorCode, message: string, options?: {
        cause?: unknown;
    });
}

export declare type ProcessRunnerErrorCode = "process_timeout" | "process_aborted" | "process_output_limit" | "process_spawn_failed";

export declare interface ProcessRunRequest {
    command: string;
    args?: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string | Uint8Array;
    timeoutMs?: number;
    signal?: AbortSignal;
    maxOutputBytes?: number;
    onData?: (chunk: Buffer) => void;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
}

export declare interface ProcessRunResult {
    command: string;
    cwd: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    failed: boolean;
}

export declare const RECOVERY_DISPOSITIONS: readonly ["replay_safe", "requires_proof", "requires_human", "forbidden"];

export declare type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

export declare function recoveryDispositionFor(capability: Pick<ResolvedToolCapability, "effect" | "replay">): RecoveryDisposition;

export declare function redactSecrets(text: string): string;

export declare interface ResolvedToolCapability extends ToolCapabilityDeclaration {
    tool: string;
    source: ToolCapabilitySource;
    resolution: ToolCapabilityResolution;
    issues: readonly string[];
}

/**
 * 解析一次工具调用的不可变能力。缺失、非法或降权冲突均返回最严格 fallback，
 * 让调用方可以记录 Fact 后失败关闭，而不是按工具名称猜测安全性。
 */
export declare function resolveToolCapability(input: ResolveToolCapabilityInput): ResolvedToolCapability;

export declare interface ResolveToolCapabilityInput {
    tool: string;
    source?: Exclude<ToolCapabilitySource, "fallback">;
    declaration?: Partial<ToolCapabilityDeclaration>;
    constraints?: readonly ToolCapabilityConstraint[];
}

/** 优先寻找 Git 安装目录内的真实 Bash，明确排除 WSL/应用商店中继。 */
export declare function resolveWindowsShell(env: NodeJS.ProcessEnv, pathExists?: (candidate: string) => boolean): ShellInvocation;

/** 脚本工具加载错误 */
export declare class ScriptToolError extends Error {
    constructor(message: string);
}

declare interface ShellInvocation {
    command: string;
    args(command: string): string[];
    input?(command: string): string;
}

/** 简化 HTML 转纯文本：去 script/style、去标签、解码实体、折叠空白 */
export declare function stripHtml(html: string): string;

export { TOOL_CAPABILITY_CHECKPOINTS }

export { TOOL_CAPABILITY_CONCURRENCY }

export { TOOL_CAPABILITY_DURABILITY }

export { TOOL_CAPABILITY_EFFECTS }

export { TOOL_CAPABILITY_REPLAYS }

export { ToolCapabilityCheckpoint }

export { ToolCapabilityConcurrency }

export declare interface ToolCapabilityConstraint {
    origin: CapabilityConstraintOrigin;
    capability: Partial<ToolCapabilityDeclaration>;
}

export { ToolCapabilityDeclaration }

export { ToolCapabilityDurability }

export { ToolCapabilityEffect }

export { ToolCapabilityReplay }

export declare type ToolCapabilityResolution = "resolved" | "fallback";

export declare type ToolCapabilitySource = "builtin" | "registered" | "inferred" | "fallback";

export declare interface UnifiedDiffOptions {
    oldPath?: string;
    newPath?: string;
    context?: number;
    maxInputBytes?: number;
    maxOutputBytes?: number;
    maxEditLength?: number;
}

declare const WebFetchParams: Type.TObject<{
    url: Type.TString;
    maxChars: Type.TOptional<Type.TInteger>;
}>;

declare const WebSearchParams: Type.TObject<{
    query: Type.TString;
    maxResults: Type.TOptional<Type.TInteger>;
}>;

/** 把依赖工具的外部临时文件适配为 CoreMind 的受控 Artifact 契约。 */
export declare function wrapToolWithArtifactCapture(tool: AgentTool, store: ArtifactStore): AgentTool;

export { }
