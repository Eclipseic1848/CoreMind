import { ArtifactRecord } from 'coremind-tools';
import type { CoreMindConfig } from 'coremind-config';
import type { LoopConfig } from 'coremind-config';
import { PermissionsConfig } from 'coremind-config';
import type { QualityConfig } from 'coremind-config';
import { RecoveryDisposition } from 'coremind-tools';
import { ResolvedToolCapability } from 'coremind-tools';
import type { RuntimeLimitsConfig } from 'coremind-config';
import type { ToolCapabilityConcurrency } from 'coremind-config';
import type { ToolCapabilityDeclaration } from 'coremind-tools';
import { ToolEffectDeclaration } from 'coremind-config';
import { ToolEffectOperation } from 'coremind-config';

export declare function advanceToolCallLifecycle(state: ToolCallLifecycleState, resolution: ToolCallPhaseResolution): ToolCallLifecycleState;

export declare function analyzeRunMetrics(events: CoreMindEvent[], messages: CoreMindMessage[], durationMs: number, outputChars: number, rejectedAfterAbort?: number): RunMetrics;

export declare type ApprovalDecision = "allow" | "deny";

declare type ArtifactProjection = Omit<ArtifactRecord, "createdAt" | "retention"> & Partial<Pick<ArtifactRecord, "createdAt" | "retention">>;

export declare function assessReleaseReadiness(outcome: RunOutcome, evaluation: EvaluationReport): ReleaseReadiness;

export declare type AuthorizationState = "pending" | "allowed" | "approved" | "denied" | "expired";

export declare interface BudgetViolation {
    dimension: "turns" | "toolCalls" | "toolFailures" | "tokens" | "costUsd";
    limit: number;
    actual: number;
    message: string;
}

/** 便捷入口：加载配置 → 构建运行时 */
export declare function buildAgentFromConfig(options: CoreMindRuntimeOptions): Promise<CoreMindRuntime>;

export declare function buildRepositoryMap(inspection: CodingRepositoryInspection, selection: CodingEnvironmentSelection): RepositoryMap;

/** 固定分区和排序规则，保证同一静态输入生成逐字节一致的 Provider 前缀。 */
export declare function buildStableContextPrefix(input: StableContextPrefixInput): StableContextPrefix;

/** 解析相对路径、symlink/junction 与 Windows 大小写后的 Workspace 身份。 */
export declare function canonicalizeWorkspace(workspaceRoot: string): Promise<string>;

/**
 * 交互式会话（库 API）：多轮对话循环，供 CLI chat 与自定义 UI 复用。
 * - 同一 agent 实例持续对话（上下文延续）
 * - onEvent 订阅归一化事件流（工具调用实时可视化等）
 * - persist() 接入运行时会话持久化（需 session.enabled + sessionId）
 */
export declare class ChatSession {
    private readonly runtime;
    readonly agentName: string;
    private readonly listeners;
    private messages;
    private activeController?;
    private latestSessionFile?;
    private latestRun?;
    constructor(runtime: CoreMindRuntime, agentName: string);
    /** 订阅会话事件（返回取消函数） */
    onEvent(listener: (event: CoreMindEvent) => void): () => void;
    /** 发送一轮消息：返回最终文本与本轮事件 */
    chat(message: string): Promise<ChatTurnResult>;
    /** 中止当前轮 */
    abort(): void;
    /** 持久化会话（需 config.session.enabled 与 runtime sessionId；返回文件路径） */
    persist(): Promise<string | undefined>;
    listCheckpoints(): CheckpointRecord[];
    diffCheckpoint(checkpointId: string): Promise<CheckpointDiff>;
    restoreCheckpoint(checkpointId: string): Promise<void>;
    private findCheckpoint;
}

/** 一轮对话的结果 */
export declare interface ChatTurnResult {
    /** 本轮最终文本（全部 assistant 文本拼接） */
    text: string;
    /** 本轮产生的归一化事件（含工具调用，UI 可实时渲染） */
    events: CoreMindEvent[];
    /** 本轮完整 Harness 结果，可用于预算、Trace、checkpoint 和质量 UI。 */
    run: RunResult;
}

export declare interface CheckFinding {
    code: string;
    severity: CheckSeverity;
    message: string;
    path?: string;
    overridable: boolean;
    overridden?: boolean;
}

declare interface CheckpointCorrelation {
    operationId?: string;
    toolCallId?: string;
    idempotencyKey?: string;
    capability?: ResolvedToolCapability;
}

export declare interface CheckpointDiff {
    checkpointId: string;
    targetPath?: string;
    changed: boolean;
    beforeSha256?: string;
    afterSha256?: string;
    beforeText?: string;
    afterText?: string;
    unifiedDiff?: string;
    reversible: boolean;
    reason?: string;
}

/** 修改工具的本地快照、diff 与显式恢复入口。 */
export declare class CheckpointManager {
    private readonly options;
    readonly records: CheckpointRecord[];
    private readonly maxFileBytes;
    constructor(options: CheckpointManagerOptions);
    capture(tool: string, args: unknown, correlation?: CheckpointCorrelation): Promise<CheckpointRecord | undefined>;
    captureAll(tool: string, args: unknown, correlation?: CheckpointCorrelation & {
        pathFields?: readonly string[];
    }): Promise<CheckpointRecord[]>;
    private snapshotTarget;
    diff(checkpointId: string): Promise<CheckpointDiff>;
    /** 工具执行结束后记录预期文件状态，供恢复时识别后续人工或并发修改。 */
    markApplied(checkpointId: string): Promise<void>;
    /** 仅在调用方显式请求时恢复单个目标文件。 */
    restore(checkpointId: string): Promise<void>;
    private persist;
    private load;
    private pathFor;
    private safeTargetPath;
}

export declare interface CheckpointManagerOptions {
    cwd: string;
    rootDir: string;
    runId: string;
    maxFileBytes?: number;
}

export declare interface CheckpointRecord {
    version: 1;
    checkpointId: string;
    runId: string;
    operationId?: string;
    toolCallId?: string;
    idempotencyKey?: string;
    timestamp: string;
    tool: string;
    reversible: boolean;
    targetPath?: string;
    existed?: boolean;
    beforeSha256?: string;
    afterExisted?: boolean;
    afterSha256?: string;
    reason?: string;
    snapshotFile: string;
}

/** development/standard/strict 三档静态质量门禁。 */
export declare function checkProject(options: ProjectCheckOptions): Promise<ProjectCheckReport>;

export declare type CheckSeverity = "error" | "warning" | "info";

/** 输入被认领：生成 claimed 事件（绑定 TurnId） */
export declare function claimInput(options: ClaimInputOptions): CoreMindEvent;

declare interface ClaimInputOptions extends InputReceiptEventOptions {
    turnId: string;
}

/** 只根据结构化状态分类；未知错误失败关闭，避免把业务失败误当成瞬态故障。 */
export declare function classifyRetry(error: unknown): RetryClassification;

export declare type CleanupState = "not_needed" | "pending" | "quiescent" | "failed";

export declare const CODING_TOOL_CONTRACTS: readonly CodingToolContract[];

export declare interface CodingEnvironmentChoice {
    language?: CodingLanguage;
    packageManager?: PackageManager;
    testCommand?: string;
}

export declare interface CodingEnvironmentSelection {
    language: CodingLanguage;
    packageManager?: PackageManager;
    testCommand: string;
    source: {
        language: "user" | "detected";
        packageManager: "user" | "detected" | "none";
    };
}

export declare class CodingKernelError extends Error {
    readonly code: CodingKernelErrorCode;
    constructor(code: CodingKernelErrorCode, message: string);
}

export declare type CodingKernelErrorCode = "coding_choice_required" | "coding_invalid_choice" | "coding_invalid_change" | "coding_verification_claim_mismatch" | "coding_delivery_not_verified";

export declare type CodingLanguage = "typescript" | "javascript" | "python";

export declare interface CodingRepositoryInspection {
    root: string;
    languageCandidates: LanguageCandidate[];
    recommendedLanguage?: CodingLanguage;
    packageManagers: PackageManager[];
    testCommands: string[];
    files: string[];
    requiresUserChoice: boolean;
    /** 探测结果只是建议；只有 selectCodingEnvironment 才形成选择。 */
    selection?: never;
}

export declare interface CodingToolContract {
    id: CodingToolId;
    purpose: string;
    phases: EngineeringPhaseId[];
    mutates: boolean;
    requiresCheckpoint: boolean;
    highRisk: boolean;
}

export declare type CodingToolId = "read" | "grep" | "find" | "edit" | "write" | "bash" | "git_status" | "git_diff" | "git_log";

export declare function collectToolReplayCandidates(trace: readonly CoreMindTraceEvent[]): ToolReplayCandidate[];

export declare interface CommandGrader extends GraderBase {
    type: "command";
    command: string;
    args?: string[];
    cwd?: string;
    exitCode?: number;
    stdoutContains?: string[];
    stdoutNotContains?: string[];
    stderrContains?: string[];
    stderrNotContains?: string[];
    timeoutMs?: number;
}

/** 只输出离线策略对照，不改变运行时默认策略。 */
export declare function compareContextStrategies(messages: CoreMindMessage[], options: ContextProtectionOptions): ContextStrategyComparison;

export declare interface CompletedWorkflowStep {
    output: StepOutput;
    saveAs?: string;
}

/** 输入对应活动已终态：生成 completed 事件 */
export declare function completeInput(options: InputReceiptEventOptions): CoreMindEvent;

declare interface ContextProjection {
    stablePrefixes: Array<{
        agent: string;
        fingerprint: string;
    }>;
    budgets: Array<{
        providerId: string;
        modelId: string;
        capabilityFingerprint: string;
        source: "locked_catalog" | "explicit_config" | "provider_metadata" | "conservative_fallback";
        confidence: "verified" | "declared" | "assumed";
        effectiveContextWindow: number;
        reservedOutputTokens: number;
        availableInputTokens: number;
        messageTokens: number;
        estimator: "pi-agent-core-estimate-v1";
    }>;
    compactions: Array<{
        beforeTokens: number;
        afterTokens: number;
        removedMessages: number;
        strategy: "deterministic-v1" | "task-state-v1";
        reason: "threshold";
        summaryFingerprint: string;
        sessionEntryId?: string;
        capabilityFingerprint?: string;
        lineageDepth?: number;
        rebuiltFromCanonical?: boolean;
        trigger?: "threshold" | "model_switch" | "provider_overflow";
    }>;
    failures: Array<{
        message: string;
        preservedMessages: number;
    }>;
    lifecycleFailures: Array<{
        code: string;
        reason: string;
        pausable: boolean;
        preservedMessages: number;
        providerCallBlocked: true;
    }>;
}

export declare interface ContextProtectionFailure {
    message: string;
    preservedMessages: number;
}

export declare interface ContextProtectionOptions {
    contextWindow: number;
    reserveTokens: number;
    keepRecentTokens: number;
}

export declare interface ContextProtectionResult {
    messages: CoreMindMessage[];
    compacted: boolean;
    beforeTokens: number;
    afterTokens: number;
    removedMessages: number;
    strategy: "none" | "deterministic-v1";
    reason?: "threshold";
    summaryFingerprint?: string;
    /** 被摘要替换的输入消息范围 [start, end)（仅压缩时存在，供会话树落盘桥接） */
    replacedRange?: {
        start: number;
        end: number;
    };
}

export declare class ContextProtector {
    private readonly options;
    private readonly onCompacted?;
    private readonly onFailed?;
    constructor(options: ContextProtectionOptions, onCompacted?: ((result: ContextProtectionResult) => void | Promise<void>) | undefined, onFailed?: ((failure: ContextProtectionFailure) => void) | undefined);
    /** 同步压缩（0.3.0 兼容入口）：异步压缩回调必须改用 transformAsync，避免落盘竞态。 */
    transform(messages: CoreMindMessage[]): CoreMindMessage[];
    /** 异步压缩：回调允许会话树落盘；回调失败时保留原文并走失败路径。 */
    transformAsync(messages: CoreMindMessage[]): Promise<CoreMindMessage[]>;
}

export declare interface ContextStrategyComparison {
    selected: "deterministic-v1";
    variants: Array<{
        strategy: "none" | "deterministic-v1" | "deterministic-v1-more-recent";
        tokens: number;
        messages: number;
    }>;
}

export declare type ControlApplyResult = "accepted" | "applied" | {
    status: "applied";
    /** applied Fact 稳定提交后执行；实现必须保证不抛错。 */
    afterDurable?: () => void | Promise<void>;
} | {
    status: "rejected";
    reason: string;
};

export declare interface ControlReceipt {
    schemaVersion: 1;
    controlId: string;
    runId: string;
    status: ControlReceiptStatus;
    acceptedSequence?: number;
    appliedSequence?: number;
    rejectedSequence?: number;
    duplicateOf?: "accepted" | "applied" | "rejected";
    reason?: string;
}

export declare type ControlReceiptStatus = "accepted" | "applied" | "rejected" | "duplicate" | "conflict";

/** CoreMind 运行时错误（带错误码，便于 CLI 与库调用方区分处理） */
export declare class CoreMindError extends Error {
    /** 机器可读错误码；分类语义见 ERROR_CODES 码表 */
    readonly code: string;
    constructor(code: string, message: string);
}

/**
 * CoreMind 归一化事件——CLI 渲染、库调用方、二期 Web 面板共用同一契约。
 * 所有事件都带 agent 名（由订阅方注入），workflow 步骤事件带 stepId。
 */
export declare type CoreMindEvent = ToolCallLifecycleFact | {
    type: "agent_start";
    agent: string;
    stepId?: string;
    turnId?: string;
} | {
    type: "turn_end";
    agent: string;
    stepId?: string;
    /** 所属 Turn（规格 02：一次请求-响应回合的身份，可选追加字段） */
    turnId?: string;
    tokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    promptCacheStatus?: "available" | "unavailable";
    costUsd?: number;
    requestsAnotherTurn?: boolean;
} | {
    type: "text_delta";
    agent: string;
    delta: string;
    stepId?: string;
} | {
    type: "tool_call";
    agent: string;
    tool: string;
    args: unknown;
    /** Trace 在脱敏前冻结的参数指纹；不保存原始正文。 */
    argumentsFingerprint?: string;
    callId?: string;
    idempotencyKey?: string;
    stepId?: string;
    turnId?: string;
} | {
    type: "tool_result";
    agent: string;
    tool: string;
    isError: boolean;
    callId?: string;
    idempotencyKey?: string;
    stepId?: string;
    turnId?: string;
} | {
    type: "tool_attempt";
    attemptId: string;
    previousReceiptId: string;
    attempt: number;
    agent: string;
    tool: string;
    callId: string;
    stepId?: string;
    argumentsFingerprint: string;
} | {
    type: "capability_resolved";
    agent: string;
    tool: string;
    callId: string;
    stepId?: string;
    capability: ResolvedToolCapability;
    recoveryDisposition: RecoveryDisposition;
} | {
    type: "workspace_lease";
    status: "acquired" | "released" | "recovery_required";
    canonicalRoot: string;
    lane: "parallel" | "run_serial" | "workspace_exclusive";
    owner: {
        runId: string;
        callId: string;
        pid: number;
    };
    agent: string;
    callId: string;
    stepId?: string;
} | {
    type: "effect_receipt";
    idempotencyKey: string;
    tool: string;
    status: EffectReceiptStatus;
    agent?: string;
    callId?: string;
    stepId?: string;
    turnId?: string;
    binding?: EffectReceiptBinding;
} | {
    type: "step_start";
    stepId: string;
    kind: string;
} | {
    type: "step_output";
    stepId: string;
    agent: string;
    text: string;
    saveAs?: string;
} | {
    type: "step_resumed";
    stepId: string;
} | {
    type: "step_end";
    stepId: string;
    ok: boolean;
} | {
    type: "loop_state";
    from: LoopPhase;
    to: LoopPhase;
    trigger: string;
    iteration: number;
    repairs: number;
    reason?: string;
} | {
    type: "retry";
    scope: "provider" | "workflow";
    attempt: number;
    stepId?: string;
} | {
    type: "approval_required";
    approvalId: string;
    runId: string;
    agent: string;
    tool: string;
    args: unknown;
    risk: "low" | "high";
    effect: ToolEffect;
    capability?: ResolvedToolCapability;
} | {
    type: "approval_resolved";
    approvalId: string;
    runId: string;
    decision: "allow" | "deny";
} | {
    type: "policy_denied";
    agent: string;
    tool: string;
    reason: string;
} | {
    type: "budget_exceeded";
    dimension: "turns" | "toolCalls" | "toolFailures" | "tokens" | "costUsd";
    limit: number;
    actual: number;
    message: string;
} | {
    type: "context_budget_resolved";
    providerId: string;
    modelId: string;
    capabilityFingerprint: string;
    source: "locked_catalog" | "explicit_config" | "provider_metadata" | "conservative_fallback";
    confidence: "verified" | "declared" | "assumed";
    effectiveContextWindow: number;
    reservedOutputTokens: number;
    availableInputTokens: number;
    messageTokens: number;
    stablePrefixTokens: number;
    toolSchemaTokens: number;
    structuredOutputTokens: number;
    multimodalTokens: number;
    protocolOverheadTokens: number;
    safetyMarginTokens: number;
    estimator: "pi-agent-core-estimate-v1";
    evidence: Array<"safe_context_intersection" | "assumed_context_window">;
} | {
    type: "context_compacted";
    beforeTokens: number;
    afterTokens: number;
    removedMessages: number;
    strategy: "deterministic-v1" | "task-state-v1";
    reason: "threshold";
    summaryFingerprint: string;
    capabilityFingerprint?: string;
    lineageDepth?: number;
    rebuiltFromCanonical?: boolean;
    trigger?: "threshold" | "model_switch" | "provider_overflow";
    /** 会话树压缩条目引用（落盘成功时存在）；摘要正文不落 RunState */
    sessionEntryId?: string;
} | {
    type: "context_compaction_failed";
    message: string;
    preservedMessages: number;
} | {
    type: "context_lifecycle_failed";
    code: "context_capability_conflict" | "context_budget_exhausted" | "context_artifact_missing" | "context_lineage_corrupt";
    reason: string;
    pausable: boolean;
    preservedMessages: number;
    providerCallBlocked: true;
} | {
    type: "context_prefix";
    agent: string;
    fingerprint: string;
} | {
    type: "provider_request";
    requestId: string;
    agent: string;
    stepId?: string;
    providerId: string;
    modelId: string;
    messageFingerprint: string;
    stablePrefixFingerprint: string;
    toolSchemaFingerprint: string;
    capabilityFingerprint: string;
    contextWorkingSetFingerprint: string;
} | {
    type: "artifact_created";
    artifactId: string;
    status: "stored" | "blocked";
    sizeBytes: number;
    relativePath?: string;
    sha256?: string;
    mediaType: string;
    redaction: "none" | "blocked-secret";
    tool: string;
    callId?: string;
} | {
    type: "extension_lifecycle";
    extensionId: string;
    extensionVersion: string;
    lifecycle: LifecycleEventType;
    status: LifecycleExtensionReceiptStatus;
    durationMs: number;
    error?: string;
    denied?: boolean;
} | {
    type: "checkpoint_created";
    checkpointId: string;
    tool: string;
    callId?: string;
    idempotencyKey?: string;
    targetPath?: string;
    reversible: boolean;
} | {
    type: "tool_execution_evidence";
    agent: string;
    tool: string;
    callId: string;
    stepId?: string;
    execution: ToolExecutionEvidence;
} | {
    type: "engineering_evidence";
    stepId: string;
    textPassed: boolean;
    passed: boolean;
    successfulTestCommands: number;
    regressionCommandMatched: boolean;
    checkpointRecorded: boolean;
    diffReviewed: boolean;
    reasons: string[];
} | {
    type: "agent_end";
    agent: string;
    stepId?: string;
    turnId?: string;
} | {
    type: "error";
    message: string;
    fatal: boolean;
} | {
    /** 输入收据（规格 03 §4）：输入到达，尚未被任何活动消费 */
    type: "input_receipt";
    inputId: string;
    status: "pending";
    /** 输入正文的短指纹（sha256 前 16 位），不落原文 */
    contentFingerprint: string;
    timestamp: string;
} | {
    /** 输入被一个 Run/Turn 认领（绑定 TurnId） */
    type: "input_claimed";
    inputId: string;
    status: "claimed";
    turnId: string;
    timestamp: string;
} | {
    /** 输入对应的活动已终态完成 */
    type: "input_completed";
    inputId: string;
    status: "completed";
    timestamp: string;
} | {
    /** 输入因取消/竞态被明确丢弃（如 abort 后未消费的排队输入） */
    type: "input_discarded";
    inputId: string;
    status: "discarded";
    timestamp: string;
} | {
    /** 静止等待超时（不改变 Run 终态，仅记录） */
    type: "quiescence_timeout";
    timeoutMs: number;
};

/** CoreMind 公共消息合同只承诺稳定、可序列化的字段，不暴露底层运行时消息类型。 */
export declare interface CoreMindMessage {
    role: "user" | "assistant" | "toolResult" | string;
    content?: CoreMindMessageContent[] | string;
    timestamp?: number;
    stopReason?: string;
    errorMessage?: string;
}

export declare type CoreMindMessageContent = {
    type: "text";
    text: string;
} | {
    type: "image";
    data: string;
    mimeType: string;
} | {
    type: "thinking";
    thinking: string;
} | {
    type: "toolCall";
    id: string;
    name: string;
    arguments: unknown;
} | {
    type: "toolResult";
    toolCallId: string;
    toolName: string;
    content: unknown;
    isError: boolean;
};

/**
 * CoreMind 运行时门面：配置 → provider/工具/agent → 执行。
 * 库形式嵌入入口：buildAgentFromConfig / CoreMindRuntime.create().run()
 */
export declare class CoreMindRuntime {
    private readonly config;
    private readonly agentConfigs;
    private readonly toolsByAgent;
    private readonly toolEffectsByAgent;
    private readonly toolCapabilitiesByAgent;
    private readonly providerRuntime;
    private readonly options;
    /** 最近创建的每个 agent 实例（收集最终消息/落盘用） */
    private readonly lastAgents;
    /** 恢复的会话上下文消息数（0 = 未恢复） */
    readonly resumedContextLength: number;
    /** 主 agent 名（会话归属） */
    private readonly mainAgentName;
    /** 恢复视图（作为主 agent 初始消息） */
    private readonly sessionMessages?;
    /** agent 名 → 注入的技能内容 */
    private readonly skillsByAgent;
    private activeHarnessFactory?;
    /** 并发 run() 检测（R7）：进行中的 run promise */
    private activeRunPromise?;
    /** 当前 run 的 journal（persistSession 的准入/abort 语义用） */
    private runJournal?;
    /** 本次 run 打开的会话（压缩条目落盘与 persist 复用同一句柄） */
    private activeSession?;
    /** 会话树已落盘视图消息 + 来源条目 id（压缩替换范围的桥接） */
    private sessionBranch?;
    /** 压缩后 agent 消息数组中被会话树代表的前缀长度（persist 跳过，避免重复落盘） */
    private compactedPrefixEnd?;
    private constructor();
    /** 由配置构建运行时（注册 provider、构建工具与全部 agent 定义） */
    static create(options: CoreMindRuntimeOptions): Promise<CoreMindRuntime>;
    /** 按名字创建独立 Agent 实例（每次新实例，消息历史独立） */
    private createAgent;
    /** 查询配置中是否存在 Agent，供交互会话在首轮前快速失败。 */
    hasAgent(name: string): boolean;
    /** 返回交互会话应继承的恢复消息副本。 */
    initialMessagesFor(name: string): CoreMindMessage[];
    /**
     * 把一轮交互对话作为完整 Run 执行。
     * 因此 chat/TUI 与无头 run 共用预算、权限、checkpoint、Trace 和失败语义。
     */
    runAgentTurn(agentName: string, message: string, history: CoreMindMessage[], events: (event: CoreMindEvent) => void, signal?: AbortSignal): Promise<RunResult>;
    inspectCheckpoint(record: CheckpointRecord): Promise<CheckpointDiff>;
    restoreCheckpoint(record: CheckpointRecord): Promise<void>;
    /** 执行：有 workflow 走编排，否则单 agent 直答。返回结果含质量摘要 */
    run(): Promise<RunResult>;
    /** 接收已类型化控制；ACK 只由当前 Run 的持久 ControlInbox 产生。 */
    acceptControl(command: RunControlCommand): Promise<ControlReceipt>;
    /** 当新的可应用点出现时，重试仍处于 accepted 的持久控制。 */
    applyPendingControls(): Promise<ControlReceipt[]>;
    private currentControlInbox;
    /** run() 主体（并发检测由外层 run() 包装） */
    private executeRunBody;
    private runWithGuard;
    private executeLoopStep;
    private abortAll;
    private applyRunControl;
    private collectMessages;
    /**
     * 等待静止（规格 03 §5）：所有 agent 已 idle ∧ 无 pending 工具结果 ∧
     * journal 无 pending flush（append 队列空且已落盘）。
     * 超时上限与 runTimeout 解耦（独立 quiescenceTimeout，默认 5s）：
     * 超时记录 quiescence_timeout 事件但不改变终态。返回是否达到静止。
     */
    waitForQuiescence(timeoutMs?: number): Promise<boolean>;
    /** 会话配置开启时，把主 agent 本轮新增消息追加落盘（返回会话文件路径） */
    persistSession(): Promise<string | undefined>;
}

export declare interface CoreMindRuntimeOptions {
    /** 已校验的配置 */
    config: CoreMindConfig;
    /** 配置文件所在目录（脚本工具相对路径、会话目录基准） */
    configDir: string;
    /** 工作目录（默认 process.cwd()） */
    cwd?: string;
    /** 环境变量（默认 process.env） */
    env?: NodeJS.ProcessEnv;
    /** 首条用户输入（注册为 {{prompt}} 变量；单 agent 模式的输入） */
    initialPrompt?: string;
    /** 事件回调（CLI 渲染 / Web 面板共用） */
    events?: (event: CoreMindEvent) => void;
    /** 带运行标识、顺序和时间戳的结构化轨迹回调。 */
    trace?: (entry: CoreMindTraceEvent) => void;
    /** ask/assisted 模式下由宿主实现的人类审批回调。 */
    approveTool?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
    /** 自定义 RunStore；缺省写入配置目录下 .coremind/runs。 */
    runStore?: RunStore;
    /** 继续一个没有 finish 记录的意外中断运行。 */
    resumeRunId?: string;
    /** 预生成的 runId（worker/客户端先取消后执行的场景；resume 时忽略） */
    runId?: string;
    /** 入口已接受的 Protocol v2 start 身份；随 start/resume Fact 持久化供 Host 重建。 */
    protocolStart?: ProtocolStartIdentity;
    /** 通过稳定 CoreMind 契约注入的 TypeScript 或跨语言工具。 */
    toolDefinitions?: CoreMindToolDefinition[];
    /** 显式注册、信任并授权的进程内生命周期扩展；不会扫描项目目录。 */
    lifecycleExtensions?: LifecycleExtensionPolicy;
    /** 可选 Telemetry 传输 seam；模式与字段范围来自已校验配置。 */
    telemetry?: Omit<TelemetryEgressControllerOptions, "policy"> & {
        /** 必须在任何 export 前以 critical Fact 持久化的显式授权。 */
        consents?: TelemetryConsentFact[];
    };
    /** ProtocolHost 控制应用 seam；持久顺序由 Runtime ControlInbox 负责。 */
    applyControl?: (command: RunControlCommand) => Promise<ControlApplyResult>;
    signal?: AbortSignal;
    /** 会话 id：落盘文件名标识（断点续聊恢复二期提供） */
    sessionId?: string;
    /** 工作流总步骤上限（护栏，默认 100） */
    maxSteps?: number;
    /** 单步骤超时毫秒（护栏，默认 300000 = 5 分钟；0 = 不超时） */
    stepTimeoutMs?: number;
}

export declare interface CoreMindToolContext {
    callId: string;
    signal?: AbortSignal;
}

/** TypeScript 与跨语言工具共同使用的稳定公共契约。 */
export declare interface CoreMindToolDefinition<TArgs = Record<string, unknown>> {
    name: string;
    label?: string;
    description: string;
    parameters: JsonObjectSchema;
    effect: ToolEffectDeclaration;
    /** 完整能力声明；省略时从旧 effect 保守推导，跨多个可变边界则 strict fallback。 */
    capability?: ToolCapabilityDeclaration;
    execute: (args: TArgs, context: CoreMindToolContext) => Promise<CoreMindToolOutput | unknown> | CoreMindToolOutput | unknown;
}

export declare interface CoreMindToolOutput {
    text: string;
    details?: unknown;
    isError?: boolean;
    terminate?: boolean;
}

/** 可持久化、可跨 SDK 对齐的一条运行轨迹。 */
export declare interface CoreMindTraceEvent {
    eventId: string;
    runId: string;
    sequence: number;
    timestamp: string;
    event: CoreMindEvent;
}

export declare function createDenyPolicyExtension(options: {
    id: string;
    deniedTools: string[];
}): LifecycleExtension;

export declare function createEngineeringKernelDefinition(options: {
    selection: CodingEnvironmentSelection;
    agents?: {
        planner?: string;
        coder?: string;
        verifier?: string;
    };
    maxIterations?: number;
    maxRepairs?: number;
    maxRepeatedAction?: number;
}): {
    loop: LoopConfig;
    requiredTools: CodingToolId[];
    excludedCapabilities: string[];
    selection: CodingEnvironmentSelection;
};

export declare function createEngineeringTaskPlan(input: {
    task: string;
    acceptanceCriteria: string[];
    selection: CodingEnvironmentSelection;
}): EngineeringTaskPlan;

export declare function createEvaluationReport(quality: QualityConfig | undefined, metrics: RunMetrics): EvaluationReport;

/** 输入到达：生成 pending 收据事件（带输入指纹与时间戳） */
export declare function createInputReceipt(options: CreateInputReceiptOptions): CoreMindEvent;

declare interface CreateInputReceiptOptions extends InputReceiptEventOptions {
    contentFingerprint: string;
}

/** 从实际 Working Set 输入生成可持久化、无正文的 Provider 请求证据。 */
export declare function createProviderRequestReplayFact(fixture: ProviderRequestReplayFixture): ProviderRequestReplayFact;

/** 在 Runtime 终态确定后生成唯一快照，供 CLI、Worker 与两个 SDK 原样传递。 */
export declare function createRunSnapshot(input: RunSnapshotInput): RunSnapshot;

/** 写入 Run start 的安全配置快照：只保留 endpoint origin，不落 query 或凭据。 */
export declare function createTelemetryConfigurationFact(policy: TelemetryPolicy, configuredAt: string): TelemetryConfigurationFact;

/** 创建与授权范围精确绑定的持久 consent Fact。 */
export declare function createTelemetryConsentFact(input: TelemetryConsentInput): TelemetryConsentFact;

/**
 * 构造供 Core 校验的出站策略收据；真实 DNS/TLS 与网络策略必须由受信任 Adapter 执行。
 */
export declare function createTelemetryEgressAuthorization(input: {
    targetOrigin: string;
    resolvedAddresses: string[];
}): TelemetryEgressAuthorization;

export declare function createToolCallLifecycle(input: ToolCallIdentity & {
    tool: string;
}): ToolCallLifecycleState;

export declare function createTraceExporterExtension(options: {
    id: string;
    exporter: (event: LifecycleExtensionEvent) => void | Promise<void>;
}): LifecycleExtension;

export declare function defineExperiment(definition: ExperimentDefinition): ExperimentDefinition;

/** 定义一个进程内扩展。显式注册代表代码信任，但能力仍需宿主逐项授权。 */
export declare function defineLifecycleExtension(extension: LifecycleExtension): LifecycleExtension;

export declare function defineTool<TArgs>(definition: CoreMindToolDefinition<TArgs>): CoreMindToolDefinition<TArgs>;

export declare interface DiffGrader extends GraderBase {
    type: "diff";
    allowedPaths?: string[];
    requiredPaths?: string[];
    forbiddenPaths?: string[];
    maxChangedFiles?: number;
    contains?: string[];
    notContains?: string[];
    preserveExisting?: boolean;
}

/** 输入被明确丢弃：生成 discarded 事件 */
export declare function discardInput(options: InputReceiptEventOptions): CoreMindEvent;

/**
 * 通用运行外围的持久操作状态，不复制 Workflow/Loop 的业务状态。
 * Loop 继续负责 planning/execute/verify/repair；本类只回答运行能否安全继续。
 */
export declare class DurableOperation {
    private readonly history;
    private readonly processedEventIds;
    private current;
    private constructor();
    static create(options: {
        runId: string;
        operationId: string;
        eventId: string;
        correlationId?: string;
        timestamp?: string;
    }): DurableOperation;
    static canTransition(from: OperationState, to: OperationState): boolean;
    static restore(records: readonly OperationStateRecord[]): DurableOperation;
    transition(event: OperationEvent): OperationTransitionResult;
    snapshot(): DurableOperationSnapshot;
    records(): OperationStateRecord[];
}

export declare interface DurableOperationSnapshot {
    schemaVersion: 1;
    operationId: string;
    runId: string;
    correlationId: string;
    state: OperationState;
    transitionSequence: number;
    createdAt: string;
    updatedAt: string;
    pauseReason?: string;
    failureReason?: string;
}

export declare interface EffectReceipt {
    idempotencyKey: string;
    tool: string;
    status: "not_started" | "started" | "committed" | "unknown";
    stepId?: string;
}

declare interface EffectReceiptBinding {
    version: 1;
    runId: string;
    turnId: string;
    agent: string;
    stepId?: string;
    callId: string;
    tool: string;
    argumentsFingerprint: string;
    capabilityFingerprint: string;
}

export declare type EffectReceiptStatus = "not_started" | "started" | "committed" | "unknown";

export declare type EffectState = "not_started" | "started" | "committed" | "unknown";

export declare interface EngineeringChange {
    path: string;
    reason: string;
    checkpointId: string;
    diff: string;
}

export declare interface EngineeringControlEvent {
    type: "approval-denied" | "aborted" | "budget-exceeded" | "no-progress";
    detail: string;
}

export declare interface EngineeringDeliverySummary {
    task: string;
    outcome: "succeeded" | "paused" | "failed" | "aborted";
    testsPassed: boolean;
    changedFiles: string[];
    changes: EngineeringChange[];
    verification: EngineeringVerification[];
    controlEvents: EngineeringControlEvent[];
    diffReviewed: boolean;
    planToolConsistency: {
        plannedTools: CodingToolId[];
        actualTools: string[];
        unplannedTools: string[];
    };
}

/**
 * @deprecated 仅用于导入旧版外部证据。新代码应使用 createEngineeringKernelDefinition，
 * 由 Runtime Trace 的 engineering_evidence 事件作为成功判定来源。
 */
export declare class EngineeringEvidenceLedger {
    private readonly input;
    private readonly changes;
    private readonly verification;
    private readonly toolCalls;
    private readonly controlEvents;
    private diffReviewed;
    constructor(input: {
        plan: EngineeringTaskPlan;
        repoMap: RepositoryMap;
    });
    recordToolCall(tool: string): void;
    recordChange(change: EngineeringChange): void;
    recordVerification(evidence: Omit<EngineeringVerification, "status"> & {
        aborted?: boolean;
    }): void;
    recordControlEvent(event: EngineeringControlEvent): void;
    markDiffReviewed(): void;
    finalize(input: {
        claimTestsPassed: boolean;
        outcome: EngineeringDeliverySummary["outcome"];
    }): EngineeringDeliverySummary;
}

export declare type EngineeringPhaseId = "understand" | "plan" | "modify" | "verify" | "repair" | "deliver";

export declare interface EngineeringTaskPlan {
    task: string;
    acceptanceCriteria: string[];
    selection: CodingEnvironmentSelection;
    phases: Array<{
        id: EngineeringPhaseId;
        objective: string;
        allowedTools: CodingToolId[];
        requiredEvidence: string[];
    }>;
}

export declare interface EngineeringVerification {
    kind: "reproduction" | "target-test" | "regression-test" | "build" | "lint";
    command: string;
    exitCode: number | null;
    durationMs: number;
    artifactRef?: string;
    status: "passed" | "failed" | "aborted";
}

export declare type EnvironmentState = "available" | "degraded" | "unavailable";

/**
 * 条件求值（刻意极简，一期不做表达式解析器）：
 * - 插值后的整体：空串视为假，"true"/"false" 字面量直接判定
 * - 支持 "X == Y"、"X != Y"、"X contains Y" 字符串比较
 * - 其他非空内容视为真
 */
export declare function evalCondition(condition: string): boolean;

export declare interface EvaluationAttempt {
    scenarioId: string;
    attempt: number;
    passed: boolean;
    transcript: string;
    outcome: RunOutcome;
    reason?: string;
    runId?: string;
    graderResults: EvaluationGraderResult[];
    metrics?: RunResult["metrics"];
    approvalCount: number;
    toolTrajectory: Array<{
        tool: string;
        callId?: string;
        isError?: boolean;
    }>;
}

export declare interface EvaluationExpectation {
    outcome?: "succeeded" | "failed";
    equals?: string;
    contains?: string[];
    notContains?: string[];
}

export declare type EvaluationGrader = OutcomeGrader | TrajectoryGrader | CommandGrader | FileGrader | DiffGrader | StateGrader | ResponseGrader;

export declare interface EvaluationGraderResult {
    id: string;
    type: EvaluationGrader["type"];
    passed: boolean;
    reason?: string;
    evidence?: Record<string, unknown>;
}

/** 业务评测与安全发现；没有运行评测时保持空数组，绝不伪造通过。 */
export declare interface EvaluationReport {
    profile: "development" | "standard" | "strict";
    scenarioResults: ScenarioResult[];
    qualityScores: Record<string, number>;
    securityFindings: string[];
}

export declare type EvaluationRuntime = {
    run(): Promise<RunResult>;
};

export declare type EvaluationRuntimeFactory = (options: CoreMindRuntimeOptions) => Promise<EvaluationRuntime>;

export declare interface EvaluationScenario {
    id: string;
    input: string;
    expected?: EvaluationExpectation;
    graders?: EvaluationGrader[];
    repetitions?: number;
}

export declare interface EvaluationSuite {
    schemaVersion: 1 | 2;
    scenarios: EvaluationScenario[];
}

export declare interface EvaluationSuiteResult {
    report: EvaluationReport;
    releaseReadiness: ReleaseReadiness;
    attempts: EvaluationAttempt[];
    passRate: number;
    totalRuns: number;
}

export declare type ExecutionOutcome = "not_invoked" | "returned" | "threw" | "timed_out" | "aborted";

export declare interface ExperimentArm {
    id: string;
    weight: number;
    config?: Readonly<Record<string, unknown>>;
}

export declare interface ExperimentDefinition {
    id: string;
    version: string;
    seed: string;
    arms: readonly ExperimentArm[];
}

export declare interface ExperimentEnvironment {
    platform: string;
    runtimeVersion: string;
    provider: string;
    model: string;
    [key: string]: string | number | boolean;
}

export declare class ExperimentError extends Error {
    readonly code: ExperimentErrorCode;
    constructor(code: ExperimentErrorCode, message: string);
}

export declare type ExperimentErrorCode = "experiment_invalid" | "experiment_run_invalid";

export declare interface ExperimentRecord {
    schemaVersion: 1;
    experiment: {
        id: string;
        version: string;
        seed: string;
    };
    selection: ExperimentSelection;
    inputFingerprint: string;
    environment: ExperimentEnvironment;
    startedAt: string;
    finishedAt: string;
    run: ExperimentRunEvidence;
}

export declare interface ExperimentRunEvidence {
    runId: string;
    outcome: RunOutcome;
    metrics: RunMetrics;
    approvalCount: number;
    trace: CoreMindTraceEvent[];
    graderResults: EvaluationGraderResult[];
}

export declare interface ExperimentSelection {
    armId: string;
    sample: number;
    assignmentHash: string;
    config?: Readonly<Record<string, unknown>>;
}

export declare type ExtensionFileCapability = "none" | "read" | "write";

/** 从 Agent 消息列表提取最终文本（拼接全部 assistant 文本块） */
export declare function extractText(messages: CoreMindMessage[]): string;

export declare interface FactAppendOptions {
    durability?: RunStoreDurability;
    eventId?: string;
}

export declare interface FactDurabilityReceipt {
    runId: string;
    sequence: number;
    eventId: string;
    kind: RunStateKind;
    durability: RunStoreDurability;
    acknowledgement: RunStoreDurabilityAcknowledgement;
    latencyMs: number;
    acknowledgedAt: string;
}

/**
 * 单个 Run 的权威 Fact 提交队列。
 *
 * 每次 append 都返回绑定该 sequence/eventId 的 Store acknowledgement；任何失败都会显式
 * poison 当前实例，阻止后续预留 sequence 被静默提交。恢复必须从 Store 稳定前缀建立新实例。
 */
export declare class FactLedger {
    readonly runId: string;
    readonly store: RunStore;
    private nextSequence;
    private tail;
    private pending;
    private terminal;
    private terminalReserved;
    private poison?;
    private readonly counters;
    constructor(runId: string, store: RunStore, initialSequence?: number);
    append(kind: RunStateKind, payload: unknown, options?: FactAppendOptions): Promise<FactDurabilityReceipt>;
    flush(): Promise<void>;
    status(): FactLedgerStatus;
    metrics(): FactLedgerMetrics;
    private poisonedError;
}

export declare interface FactLedgerLevelMetrics {
    succeeded: number;
    failed: number;
    totalLatencyMs: number;
    maxLatencyMs: number;
}

export declare interface FactLedgerMetrics {
    pending: number;
    ordinary: FactLedgerLevelMetrics;
    critical: FactLedgerLevelMetrics;
}

export declare type FactLedgerStatus = {
    state: "healthy";
    nextSequence: number;
    terminal: boolean;
} | {
    state: "poisoned";
    failedSequence: number;
    reason: string;
};

export declare interface FileGrader extends GraderBase {
    type: "file";
    path: string;
    exists?: boolean;
    equals?: string;
    contains?: string[];
    notContains?: string[];
    unchanged?: boolean;
    maxBytes?: number;
}

export declare class FileRunStore implements RunStore {
    readonly directory: string;
    private readonly options;
    readonly supportedDurability: readonly ["ordinary", "critical"];
    readonly durabilityBoundary: "process_crash";
    constructor(directory: string, options?: FileRunStoreOptions);
    pathFor(runId: string): string;
    append(record: RunStateRecord): Promise<void>;
    commit(record: RunStateRecord, durability: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    barrier(runId: string, requested: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    read(runId: string): Promise<RunStateRecord[]>;
    private readUnlocked;
    private publishAtomically;
    private writeRecord;
    private withWriterLock;
    private reclaimStaleWriterLock;
}

/** 本地 JSONL RunStore：每条记录只追加，不覆盖既有审计。 */
declare interface FileRunStoreOptions {
    /** 仅供故障注入测试：临时文件完成后、原子发布前调用。 */
    beforeCommit?: (context: {
        destination: string;
        temporary: string;
        record?: RunStateRecord;
    }) => void | Promise<void>;
    /** 仅供故障注入测试：critical barrier 同步文件前调用。 */
    beforeBarrier?: (context: {
        destination: string;
        runId: string;
        requested: RunStoreDurability;
        /** 精确 Fact commit 时为当前记录；全局 barrier 时缺省。 */
        record?: RunStateRecord;
    }) => void | Promise<void>;
    lockTimeoutMs?: number;
}

/** 配置指纹只落 hash，不把配置或凭据复制进 RunState。 */
export declare function fingerprintRunConfig(config: unknown): string;

/**
 * 从事件序列折叠每个输入的当前状态（规格 §4：状态由事件序列折叠，不覆盖旧记录）。
 * 非法转移（completed/discarded 后再次推进、未登记就转移）抛错——语义损坏 fail closed。
 * 事件乱序时按 inputId 独立推进（同一输入的事件仍按到达顺序判定转移）。
 */
export declare function foldInputReceipts(events: readonly CoreMindEvent[]): Map<InputId, InputReceiptStatus>;

export declare function formatMetrics(metrics: RunMetrics): string;

declare interface GraderBase {
    id?: string;
}

/** 输入正文的稳定短指纹（sha256 前 16 位）：Trace 只保存摘要，不落原文 */
export declare function inputFingerprint(content: string): string;

/**
 * 输入收据与静止判定（规格 docs/spec/0.3.x-a/03-cancellation-and-quiescence.md §4）。
 *
 * 每个外部输入获得稳定 ID 与四态收据：
 *
 * ```
 * pending → claimed → completed
 *         ↘ discarded
 * ```
 *
 * - pending：输入已收到、尚未被任何活动消费
 * - claimed：输入被一个 Run/Turn 认领（绑定 TurnId）
 * - discarded：因取消/竞态被明确丢弃（如 abort 后到达的排队输入）
 * - completed：输入对应的活动已终态
 *
 * 状态转移是追加事件（input_claimed / input_completed / input_discarded），由事件序列
 * 折叠出当前状态——不覆盖旧记录。折叠遇到非法转移（无回退）抛错，语义损坏 fail closed。
 */
/** 品牌化的输入 ID（规格 02：跨 Run/Turn 稳定；协议边界序列化为 string） */
export declare type InputId = string & {
    readonly __brand: "InputId";
};

declare interface InputReceiptEventOptions {
    inputId: InputId;
    timestamp?: string;
}

export declare type InputReceiptStatus = "pending" | "claimed" | "completed" | "discarded";

/** 使用 RunResult 中的记录重新计算当前 diff。 */
export declare function inspectCheckpoint(record: CheckpointRecord, cwd: string): Promise<CheckpointDiff>;

/** 只读且有界地探测仓库；结果是建议，不会替用户选择语言或命令。 */
export declare function inspectCodingRepository(repositoryRoot: string, options?: {
    maxFiles?: number;
}): Promise<CodingRepositoryInspection>;

export declare function inspectRuntimeCompatibility(): RuntimeCompatibilityReport;

/** 该事件是否属于输入收据事件族（折叠时过滤用） */
export declare function isInputReceiptEvent(event: CoreMindEvent): boolean;

/** 由 Runtime 单点判断持久化运行是否满足自动恢复的安全前提。 */
export declare function isRunStateResumable(records: readonly RunStateRecord[]): boolean;

export declare function isTelemetryConsentFact(value: unknown): value is TelemetryConsentFact;

/** 转移合法性：undefined（未登记）只能到 pending（登记）；否则按转移表 */
export declare function isValidTransition(from: InputReceiptStatus | undefined, to: InputReceiptStatus): boolean;

export declare interface JsonObjectSchema extends Record<string, unknown> {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
}

export declare interface LanguageCandidate {
    language: CodingLanguage;
    score: number;
    evidence: string[];
}

export declare const LIFECYCLE_EVENTS: readonly ["before-model", "before-tool", "after-tool", "run-finished"];

export declare interface LifecycleDispatchResult {
    receipts: LifecycleExtensionReceipt[];
    denied?: {
        extensionId: string;
        reason: string;
    };
}

export declare type LifecycleEventType = (typeof LIFECYCLE_EVENTS)[number];

export declare interface LifecycleExtension {
    id: string;
    version: string;
    capabilities: LifecycleExtensionCapabilities;
    handlers: Partial<Record<LifecycleEventType, LifecycleExtensionHandler>>;
}

export declare interface LifecycleExtensionCapabilities {
    files: ExtensionFileCapability;
    process: boolean;
    network: boolean;
    credentials: boolean;
    ui: boolean;
}

export declare interface LifecycleExtensionDecision {
    /** 扩展只能附加拒绝，不能授予权限或改写人工审批。 */
    deny?: {
        reason: string;
    };
}

export declare class LifecycleExtensionError extends Error {
    readonly code: LifecycleExtensionErrorCode;
    constructor(code: LifecycleExtensionErrorCode, message: string);
}

export declare type LifecycleExtensionErrorCode = "extension_invalid" | "extension_duplicate" | "extension_not_trusted" | "extension_capability_denied";

export declare interface LifecycleExtensionEvent {
    type: LifecycleEventType;
    occurredAt: string;
    payload: Readonly<Record<string, unknown>>;
}

export declare type LifecycleExtensionHandler = (event: LifecycleExtensionEvent) => void | LifecycleExtensionDecision | Promise<void | LifecycleExtensionDecision>;

export declare class LifecycleExtensionHost {
    private readonly extensions;
    private readonly timeoutMs;
    constructor(policy: LifecycleExtensionPolicy);
    dispatch(type: LifecycleEventType, payload: Record<string, unknown>): Promise<LifecycleDispatchResult>;
}

export declare interface LifecycleExtensionPolicy {
    extensions: LifecycleExtension[];
    /** 显式信任清单；CoreMind 不扫描或自动加载项目本地扩展。 */
    trustedIds: string[];
    grants: Record<string, LifecycleExtensionCapabilities>;
    timeoutMs?: number;
}

export declare interface LifecycleExtensionReceipt {
    extensionId: string;
    extensionVersion: string;
    event: LifecycleEventType;
    status: LifecycleExtensionReceiptStatus;
    durationMs: number;
    error?: string;
    denied?: boolean;
}

export declare type LifecycleExtensionReceiptStatus = "succeeded" | "failed" | "timed_out";

/** 锁定 pi-ai 版本提供的完整静态 Provider 清单。 */
export declare function listInheritedProviders(): string[];

/** CoreMind 可直接配置的完整 Provider 清单，包括继承入口与原生认证入口。 */
export declare function listSupportedProviders(): string[];

export declare function loadEvaluationSuite(file: string): Promise<EvaluationSuite>;

export declare interface LocalObservabilityProjection {
    schemaVersion: 1;
    localEnabled: true;
    derivedFromSequence: number;
    run: {
        status: RunProjectionStatus;
        resumable: boolean;
        operationState?: string;
        durationMs?: number;
    };
    turns: {
        started: number;
        completed: number;
        active: number;
    };
    calls: {
        started: number;
        completed: number;
        failed: number;
        active: number;
        durationMs: number;
    };
    tools: ToolCallLifecycleState[];
    errors: Array<{
        sequence: number;
        message: string;
        fatal: boolean;
    }>;
    context: {
        budgets: number;
        compactions: number;
        failures: number;
    };
    artifacts: {
        stored: number;
        blocked: number;
    };
    sharedState: {
        pendingControls: number;
    };
    recovery: {
        resumable: boolean;
        operationState?: string;
    };
    telemetry: TelemetryDeliveryProjection & {
        source: TelemetryConfigurationSource;
        deliverySemantics: "best_effort_handoff_not_delivery";
        authorizedScopes: TelemetryAuthorizationScope[];
    };
}

/** XState 只存在于此适配器内部；调用方只读写 CoreMind 的领域事件和版本化快照。 */
export declare class LoopController {
    readonly config: LoopControllerConfig;
    private readonly actor;
    private transitionSequence;
    private readonly listeners;
    constructor(config: LoopControllerConfig, snapshot?: LoopControllerSnapshot);
    static restore(config: LoopControllerConfig, snapshot: LoopControllerSnapshot): LoopController;
    get phase(): LoopPhase;
    send(event: LoopControllerEvent): void;
    subscribe(listener: (event: LoopTransition) => void): () => void;
    getSnapshot(): LoopControllerSnapshot;
}

export declare interface LoopControllerConfig {
    runId: string;
    configFingerprint: string;
    hasPlanning: boolean;
    maxIterations: number;
    maxRepairs: number;
    maxRepeatedAction: number;
    onFailure: LoopFailureStrategy;
    onExhausted: LoopExhaustedStrategy;
}

export declare type LoopControllerEvent = {
    type: "START";
} | {
    type: "PLANNED";
} | {
    type: "EXECUTED";
    fingerprint: string;
} | {
    type: "VERIFIED";
    passed: boolean;
} | {
    type: "REPAIRED";
    fingerprint: string;
} | {
    type: "PAUSE";
    reason: string;
} | {
    type: "RESUME";
} | {
    type: "ABORT";
} | {
    type: "TIMEOUT";
} | {
    type: "BUDGET_EXCEEDED";
} | {
    type: "FAIL";
    code: string;
    message: string;
};

export declare interface LoopControllerSnapshot {
    schemaVersion: 1;
    machineVersion: "1";
    runId: string;
    configFingerprint: string;
    phase: LoopPhase;
    iteration: number;
    repairCount: number;
    repeatedActionCount: number;
    transitionSequence: number;
    lastActionFingerprint?: string;
    pauseReason?: string;
    resumePhase?: Exclude<LoopPhase, "paused">;
    failureCode?: string;
    failureMessage?: string;
}

export declare type LoopExhaustedStrategy = "pause" | "fail";

export declare type LoopFailureStrategy = "repair" | "pause" | "fail";

export declare type LoopPhase = "idle" | "planning" | "executing" | "verifying" | "repairing" | "paused" | "succeeded" | "failed" | "aborted" | "timeout" | "budget_exceeded";

/** 执行显式、有限、可恢复的规划—执行—验证—修复循环。 */
export declare class LoopRunner {
    private readonly options;
    readonly outputs: Map<string, StepOutput>;
    private readonly variables;
    private readonly controller;
    private readonly completedSteps;
    constructor(options: LoopRunnerOptions);
    getSnapshot(): LoopControllerSnapshot;
    /** 由 Runtime 的总超时或外部取消入口推进到同一确定性终态。 */
    interrupt(error: unknown): Promise<void>;
    run(): Promise<LoopRunResult>;
    private runPlanning;
    private runExecution;
    private runVerification;
    private runRepair;
    private runStep;
    private saveOutput;
    private interpolate;
    private sendAndPersist;
    private recordExecutionError;
    private result;
}

export declare interface LoopRunnerOptions {
    runId: string;
    configFingerprint: string;
    initialPrompt?: string;
    loop: LoopConfig;
    executeStep: (request: LoopStepRequest) => Promise<string>;
    emit: (event: CoreMindEvent) => void;
    persistSnapshot: (snapshot: LoopControllerSnapshot) => Promise<void>;
    restoredSnapshot?: LoopControllerSnapshot;
    completedSteps?: ReadonlyMap<string, CompletedWorkflowStep>;
    /** Runtime 证据门；返回 false 时即使文本条件为真也不能完成。 */
    verifyEvidence?: (request: {
        iteration: number;
        stepId: string;
        textPassed: boolean;
    }) => boolean | Promise<boolean>;
}

export declare interface LoopRunResult {
    outputs: Map<string, StepOutput>;
    transcript: string;
    snapshot: LoopControllerSnapshot;
    error?: unknown;
}

export declare type LoopStepKind = "planning" | "execute" | "verify" | "repair";

export declare interface LoopStepRequest {
    kind: LoopStepKind;
    stepId: string;
    agent: string;
    input: string;
}

export declare interface LoopTransition {
    sequence: number;
    event: LoopControllerEvent["type"];
    from: LoopPhase;
    to: LoopPhase;
    snapshot: LoopControllerSnapshot;
}

export declare class MemoryRunStore implements RunStore {
    readonly supportedDurability: readonly ["ordinary"];
    readonly durabilityBoundary: "process_memory";
    private readonly records;
    append(record: RunStateRecord): Promise<void>;
    commit(record: RunStateRecord, durability: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    read(runId: string): Promise<RunStateRecord[]>;
    barrier(_runId: string, requested: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
}

/** 生成新的输入 ID（与 RunId/TurnId 同源的 randomUUID 品牌类型） */
export declare function newInputId(): InputId;

/**
 * 把上游 Agent 事件归一化为 CoreMind 事件。
 * 只保留对 UI/调用方有意义的事件；流式文本来自 message_update 的 text_delta。
 */
export declare function normalizeEvent(event: unknown): CoreMindEvent | null;

export declare interface OperationEvent {
    eventId: string;
    type: Exclude<OperationEventType, "ACCEPT">;
    timestamp?: string;
    reason?: string;
}

export declare type OperationEventType = "ACCEPT" | "START" | "PAUSE" | "RESUME" | "REQUEST_ABORT" | "COMPLETE" | "FAIL";

/** 从 RunState 中校验并提取最新 operation 快照，供 CLI/SDK/Worker 共用。 */
export declare function operationSnapshotFromRecords(records: readonly RunStateRecord[]): DurableOperationSnapshot | undefined;

export declare type OperationState = "accepted" | "running" | "paused" | "aborting" | "completed" | "failed";

export declare interface OperationStateRecord {
    schemaVersion: 1;
    operationId: string;
    runId: string;
    correlationId: string;
    sequence: number;
    eventId: string;
    event: OperationEventType;
    from: OperationState | null;
    to: OperationState;
    timestamp: string;
    reason?: string;
}

export declare interface OperationTransitionResult {
    changed: boolean;
    snapshot: DurableOperationSnapshot;
    record?: OperationStateRecord;
}

export declare interface OutcomeGrader extends GraderBase {
    type: "outcome";
    status: RunStatus;
    finishReason?: string;
}

export declare type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

declare interface PendingApprovalControl {
    type: "approval";
    approvalId: string;
    runId: string;
    agent: string;
    tool: string;
    risk: "low" | "high";
}

declare type PendingControl = PendingApprovalControl | PendingControlProjection;

declare interface PendingControlProjection {
    source: "control_inbox";
    controlId: string;
    runId: string;
    type: RunControlCommand["type"];
    acceptedSequence: number;
    command: RunControlCommand;
}

export declare type PersistenceState = "pending" | "durable" | "failed" | "unknown";

/** 从中断的 append-only RunState 构造安全恢复计划。 */
export declare function prepareRunResume(records: RunStateRecord[], configFingerprint: string, requestedPrompt?: string): RunResumePlan;

export declare interface ProjectCheckOptions {
    config: CoreMindConfig;
    projectDir: string;
    profile?: QualityConfig["profile"];
    overrideReason?: string;
}

export declare interface ProjectCheckReport {
    profile: "development" | "standard" | "strict";
    passed: boolean;
    findings: CheckFinding[];
    overrideRecord?: {
        reason: string;
        recordedAt: string;
        codes: string[];
        auditFile: string;
    };
}

/** 从 canonical Run Facts 重建默认开启的本地观测视图。 */
export declare function projectLocalObservability(records: readonly RunStateRecord[], options?: ProjectLocalObservabilityOptions): LocalObservabilityProjection;

export declare interface ProjectLocalObservabilityOptions {
    runStatus?: RunProjectionStatus;
    resumable?: boolean;
    operationState?: string;
    context?: {
        budgets: number;
        compactions: number;
        failures: number;
    };
    artifacts?: {
        stored: number;
        blocked: number;
    };
    pendingControls?: number;
    telemetryDelivery?: TelemetryDeliveryProjection;
}

export declare function projectToolCallLifecycles(facts: readonly unknown[]): ToolCallLifecycleState[];

/** 从同一 Runtime 的规范化 Fact 生成入口共享的 Capability 视图。 */
export declare function projectToolCapabilities(events: readonly CoreMindEvent[]): ToolCapabilityProjection[];

/** 0.3.0/0.3.1 RunState 读取端：只使用当时已持久化的 Fact，不按名称补写结论。 */
export declare function projectToolCapabilitiesFromRecords(records: readonly RunStateRecord[]): ToolCapabilityProjection[];

/** 从规范化 Lease Fact 折叠当前状态；缺失历史 Fact 时不按路径或工具名补写。 */
export declare function projectWorkspaceLeases(events: readonly CoreMindEvent[]): WorkspaceLeaseProjection[];

export declare function projectWorkspaceLeasesFromRecords(records: readonly RunStateRecord[]): WorkspaceLeaseProjection[];

/**
 * 在每次 Provider 请求前执行的本地上下文保护。
 * 摘要只在用户环境生成；保留区从 user 消息开始，避免留下孤立 toolResult。
 */
export declare function protectContext(messages: CoreMindMessage[], options: ContextProtectionOptions): ContextProtectionResult;

export declare interface ProtocolStartIdentity {
    protocolVersion: "2.0";
    method: "run" | "chat" | "resume";
    fingerprint: string;
    acceptedAt: string;
}

export declare interface ProviderRequestReplayFact {
    requestId: string;
    providerId: string;
    modelId: string;
    messageFingerprint: string;
    stablePrefixFingerprint: string;
    toolSchemaFingerprint: string;
    capabilityFingerprint: string;
    contextWorkingSetFingerprint: string;
}

export declare interface ProviderRequestReplayFixture {
    requestId: string;
    providerId: string;
    modelId: string;
    messages: readonly unknown[];
    stablePrefix: string;
    toolSchemas: readonly unknown[];
    capabilityFingerprint: string;
}

/** 事件序列中某输入的最新收据状态（折叠查询的便捷封装） */
export declare function receiptStatusOf(events: readonly CoreMindEvent[], inputId: InputId): InputReceiptStatus | undefined;

declare interface RecoveryDecision {
    resumable: boolean;
    operation?: DurableOperationSnapshot;
}

/** 发布判断与普通运行成功分离。 */
export declare interface ReleaseReadiness {
    ready: boolean;
    blockers: string[];
    warnings: string[];
    overrideRecord?: {
        reason: string;
        recordedAt: string;
    };
}

export declare interface ReplayFixture {
    facts: readonly RunStateRecord[];
    providerRequests: readonly ProviderRequestReplayFixture[];
}

/** 对固定 canonical Facts 与请求 fixture 执行无副作用、可重复的本地重放。 */
export declare const ReplayKit: {
    replay(fixture: ReplayFixture): ReplayResult;
};

export declare interface ReplayResult {
    schemaVersion: 1;
    factFingerprint: string;
    replayFingerprint: string;
    projection: RunProjection;
    observation: LocalObservabilityProjection;
    providerRequests: ProviderRequestReplayFact[];
}

export declare interface RepositoryMap {
    root: string;
    language: CodingLanguage;
    packageManager?: PackageManager;
    testCommand: string;
    entries: RepositoryMapEntry[];
}

export declare interface RepositoryMapEntry {
    path: string;
    kind: "manifest" | "source" | "test" | "documentation" | "configuration" | "other";
    language?: CodingLanguage;
}

export declare interface ResolvedRuntimeLimits {
    maxTurns: number;
    maxSteps: number;
    stepTimeoutMs: number;
    runTimeoutMs: number;
    maxToolCalls: number;
    maxToolFailures: number;
    maxRetries: number;
    maxTokens?: number;
    maxCostUsd?: number;
}

export declare function resolveRuntimeLimits(config: RuntimeLimitsConfig | undefined, overrides: Pick<ResolvedRuntimeLimits, "maxSteps" | "stepTimeoutMs"> | Partial<ResolvedRuntimeLimits>): ResolvedRuntimeLimits;

export declare interface ResponseGrader extends GraderBase {
    type: "response";
    equals?: string;
    contains?: string[];
    notContains?: string[];
}

/** 使用 RunResult 中的记录显式恢复目标文件。 */
export declare function restoreCheckpoint(record: CheckpointRecord, cwd: string): Promise<void>;

export declare function restoreDurableOperation(records: readonly OperationStateRecord[]): DurableOperation;

export declare type RetryCategory = "transient" | "permanent" | "human";

export declare interface RetryClassification {
    category: RetryCategory;
    retryable: boolean;
    reason: string;
}

/** 一次 Run 独占的多维预算计数器。 */
export declare class RunBudgetController {
    readonly limits: ResolvedRuntimeLimits;
    private readonly emit;
    private turns;
    private toolCalls;
    private toolFailures;
    private tokens;
    private costUsd;
    violation?: BudgetViolation;
    constructor(limits: ResolvedRuntimeLimits, emit: (event: CoreMindEvent) => void);
    /** 恢复运行时重放既有 Trace 的计数，不重复发出事件或副作用。 */
    restore(event: CoreMindEvent): void;
    beforeToolCall(): {
        block: true;
        reason: string;
    } | undefined;
    afterToolCall(isError: boolean): {
        terminate: true;
    } | undefined;
    observeAgentEvent(event: unknown): boolean;
    throwIfExceeded(): void;
    private fail;
}

declare interface RunControlBase {
    schemaVersion: 1;
    controlId: string;
    runId: string;
}

export declare type RunControlCommand = (RunControlBase & {
    type: "cancel";
    reason?: string;
}) | (RunControlBase & {
    type: "approval";
    approvalId: string;
    decision: "allow" | "deny";
}) | (RunControlBase & {
    type: "steering";
    message: string;
}) | (RunControlBase & {
    type: "follow_up";
    message: string;
});

export declare interface RunEvaluationOptions {
    config: CoreMindConfig;
    configDir: string;
    cwd?: string;
    suite: EvaluationSuite;
    runtimeFactory?: EvaluationRuntimeFactory;
    approveTool?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
}

/** 使用真实 CoreMindRuntime 重复运行场景，失败异常也会进入评测报告。 */
export declare function runEvaluationSuite(options: RunEvaluationOptions): Promise<EvaluationSuiteResult>;

export declare function runExperiment(options: {
    definition: ExperimentDefinition;
    inputFingerprint: string;
    environment: ExperimentEnvironment;
    run: (arm: ExperimentArm) => Promise<ExperimentRunEvidence>;
}): Promise<ExperimentRecord>;

/** 可观测的执行成本与规模，不对业务正确性作判断。 */
export declare interface RunMetrics {
    durationMs: number;
    turns: number;
    steps: {
        total: number;
        succeeded: number;
        failed: number;
    };
    toolCalls: number;
    toolFailures: number;
    retries: number;
    tokens?: number;
    costUsd?: number;
    outputChars: number;
    context?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        promptCacheStatus: "available" | "unavailable" | "unknown";
        compactions: number;
        lastSummaryFingerprint?: string;
        stablePrefixFingerprints: string[];
        lastBudget?: {
            providerId: string;
            modelId: string;
            capabilityFingerprint: string;
            source: "locked_catalog" | "explicit_config" | "provider_metadata" | "conservative_fallback";
            confidence: "verified" | "declared" | "assumed";
            effectiveContextWindow: number;
            reservedOutputTokens: number;
            availableInputTokens: number;
            messageTokens: number;
            estimator: "pi-agent-core-estimate-v1";
        };
    };
    artifacts?: {
        stored: number;
        blocked: number;
        totalBytes: number;
    };
    /** 取消收敛：事件准入拒绝写入的迟到终态事件数（规格 03 §3） */
    rejectedAfterAbort?: number;
}

/** 运行是否以及为何结束；不与质量评分混在一起。 */
export declare interface RunOutcome {
    status: RunStatus;
    finishReason: string;
    error?: {
        code: string;
        message: string;
    };
}

declare interface RunProjection {
    schemaVersion: 1;
    runId: string;
    status: RunProjectionStatus;
    resumable: boolean;
    operation?: DurableOperationSnapshot;
    outcome?: RunOutcome;
    recovery: RecoveryDecision;
    trace: CoreMindTraceEvent[];
    checkpoints: CheckpointRecord[];
    artifacts: ArtifactProjection[];
    extensions: LifecycleExtensionReceipt[];
    context: ContextProjection;
    pendingControls: PendingControl[];
    observability: LocalObservabilityProjection;
    records: RunStateRecord[];
    snapshot?: RunSnapshot;
}

declare type RunProjectionStatus = "finished" | "paused" | "interrupted";

export declare interface RunResult {
    runId: string;
    /** 通用 durable operation 的权威外围状态；Workflow/Loop 细节仍由各自快照负责。 */
    operation: DurableOperationSnapshot;
    outcome: RunOutcome;
    metrics: RunMetrics;
    evaluation: EvaluationReport;
    releaseReadiness: ReleaseReadiness;
    trace: CoreMindTraceEvent[];
    runStateFile?: string;
    checkpoints: CheckpointRecord[];
    /** workflow 步骤输出（saveAs → 输出） */
    outputs: Map<string, StepOutput>;
    /** agent 名 → 最终消息 */
    messages: Map<string, CoreMindMessage[]>;
    /** 主输出文本（CLI --print 直接打印） */
    transcript: string;
    /** 会话文件路径（已落盘时） */
    sessionFile?: string;
    /** 本轮产生或因敏感内容而阻断的完整输出记录。 */
    artifacts?: ArtifactRecord[];
    /** 四个只读生命周期事件的扩展执行收据。 */
    extensions?: LifecycleExtensionReceipt[];
    /** CLI、Worker、TypeScript SDK 与 Python SDK 共用的纯 JSON 权威快照。 */
    snapshot: RunSnapshot;
    /** 默认开启、从 Facts 派生的本地观测；外传交付状态不参与恢复。 */
    observability: LocalObservabilityProjection;
}

export declare interface RunResumePlan {
    runId: string;
    initialPrompt?: string;
    nextJournalSequence: number;
    nextTraceSequence: number;
    completedSteps: Map<string, CompletedWorkflowStep>;
    effectReceipts: Map<string, EffectReceipt>;
    toolReplayCandidates: ToolReplayCandidate[];
    previousTrace: CoreMindTraceEvent[];
    loopSnapshot?: LoopControllerSnapshot;
    operationSnapshot?: DurableOperationSnapshot;
    operationRecords: OperationStateRecord[];
}

/** 所有入口共享的、纯 JSON 运行快照；不包含 Map、回调或 Provider 私有对象。 */
export declare interface RunSnapshot {
    schemaVersion: 1;
    runId: string;
    operation: DurableOperationSnapshot;
    outcome: RunOutcome;
    metrics: RunMetrics;
    evaluation: EvaluationReport;
    releaseReadiness: ReleaseReadiness;
    trace: CoreMindTraceEvent[];
    checkpoints: CheckpointRecord[];
    artifacts: ArtifactRecord[];
    extensions: LifecycleExtensionReceipt[];
    resumable: boolean;
}

export declare type RunSnapshotInput = Omit<RunSnapshot, "schemaVersion" | "resumable">;

/** 把同步事件串行化为 RunStore 的有序异步写入。 */
export declare class RunStateJournal {
    readonly runId: string;
    readonly store: RunStore;
    private readonly ledger;
    private aborted;
    private rejectedAfterAbortCount;
    private knownTurnIds?;
    private readonly durabilityCounters;
    constructor(runId: string, store: RunStore, initialSequence?: number);
    /**
     * 取消收敛：设置事件准入分界点（规格 03 §3）。
     * 此后收尾事实（operation/loop/pause/finish）放行；终态类事件被静默拒绝并计数。
     * knownTurnIds：分界前已启动的活动集合（R3 判定：分界前启动的工具 receipt 放行）。
     */
    markAborted(knownTurnIds?: ReadonlySet<string>): void;
    /** 已设置准入分界点（transcript 回退等取消语义依赖此标志） */
    isAborted(): boolean;
    /** 准入拒绝的事件计数（记入 metrics.rejectedAfterAbort） */
    rejectedAfterAbort(): number;
    /**
     * 事件准入（trace 层前置调用，规格 03 §3 / ADR"不入 Trace 或 journal"）：
     * abort 后的迟到终态事实返回 false（计数），调用方不写入 trace/collected/回调。
     */
    admitEvent(event: CoreMindEvent): boolean;
    start(payload: unknown): Promise<void>;
    event(payload: unknown): void;
    resume(payload: unknown): void;
    checkpoint(payload: unknown): void;
    loop(payload: LoopControllerSnapshot): void;
    operation(payload: OperationStateRecord): void;
    pause(payload: unknown): void;
    finish(payload: unknown): void;
    flush(durability?: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    durabilityMetrics(): RunStoreDurabilityMetrics;
    appendFact(kind: RunStateKind, payload: unknown, options?: FactAppendOptions): Promise<FactDurabilityReceipt>;
    factMetrics(): FactLedgerMetrics;
    factStatus(): FactLedgerStatus;
    pendingFactCount(): number;
    private enqueue;
}

export declare type RunStateKind = "start" | "resume" | "telemetry_configuration" | "telemetry_consent" | "control" | "event" | "checkpoint" | "loop" | "operation" | "pause" | "finish";

export declare interface RunStateRecord {
    version: 1;
    runId: string;
    sequence: number;
    eventId?: string;
    timestamp: string;
    kind: RunStateKind;
    payload: unknown;
}

export declare type RunStatus = "succeeded" | "failed" | "paused" | "aborted" | "timeout" | "budget_exceeded";

export declare interface RunStore {
    /** 旧 Adapter 缺省时仅按 ordinary/process_memory 兼容，critical 必须失败关闭。 */
    readonly supportedDurability?: readonly RunStoreDurability[];
    readonly durabilityBoundary?: RunStoreDurabilityBoundary;
    append(record: RunStateRecord): Promise<void>;
    commit?(record: RunStateRecord, durability: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    barrier?(runId: string, requested: RunStoreDurability): Promise<RunStoreDurabilityAcknowledgement>;
    read(runId: string): Promise<RunStateRecord[]>;
    pathFor?(runId: string): string;
}

export declare type RunStoreDurability = "ordinary" | "critical";

export declare interface RunStoreDurabilityAcknowledgement {
    requested: RunStoreDurability;
    achieved: RunStoreDurability;
    boundary: RunStoreDurabilityBoundary;
}

export declare type RunStoreDurabilityBoundary = "process_memory" | "process_crash" | "system_crash" | "power_loss";

export declare interface RunStoreDurabilityMetrics {
    ordinary: {
        succeeded: number;
        failed: number;
    };
    critical: {
        succeeded: number;
        failed: number;
    };
}

/**
 * 把一次运行的所有结束路径收敛为稳定终态。
 *
 * 调用方只需要判断 RunOutcome，不需要同时处理“返回值”和“抛异常”两套协议。
 */
export declare class RunTerminalizer {
    terminalize(events: CoreMindEvent[], error?: unknown): RunOutcome;
}

/** CoreMind 对低层运行依赖的唯一能力说明；调用方无需理解依赖包结构。 */
export declare interface RuntimeCompatibilityReport {
    dependencyFamily: string;
    adapterVersion: number;
    errorMappingVersion: number;
    capabilities: {
        streaming: boolean;
        toolCalls: boolean;
        abort: boolean;
        usage: boolean;
        errors: boolean;
        timeouts: boolean;
    };
}

/** 执行有界重试；只有明确分类为 transient 的失败才能进入下一次尝试。 */
export declare function runWithTransientRetry<T>(operation: () => Promise<T>, options: TransientRetryOptions): Promise<T>;

export declare interface ScenarioResult {
    id: string;
    passed: boolean;
    score?: number;
    reason?: string;
}

export declare function selectCodingEnvironment(inspection: CodingRepositoryInspection, choice: CodingEnvironmentChoice): Promise<CodingEnvironmentSelection>;

export declare function selectExperimentArm(definition: ExperimentDefinition, inputFingerprint: string): ExperimentSelection;

export declare interface StableContextPrefix {
    text: string;
    fingerprint: string;
}

export declare interface StableContextPrefixInput {
    projectInstructions: string;
    tools: Array<{
        name: string;
        description: string;
    }>;
    stableFacts?: Record<string, string | number | boolean>;
    skillsContent?: string[];
}

export declare interface StateGrader extends GraderBase {
    type: "state";
    finishReason?: string;
    minCheckpoints?: number;
    maxToolFailures?: number;
    maxTurns?: number;
    maxApprovals?: number;
    maxSecurityFindings?: number;
}

/** 单个步骤的输出 */
export declare interface StepOutput {
    text: string;
    metadata: {
        agent: string;
        stepId: string;
    };
}

export declare interface TelemetryAuthorizationScope {
    runId: string;
    consentId: string;
    scopeFingerprint: string;
    kind: TelemetryConsentFact["kind"];
    targetOrigin: string;
    contentLevel: TelemetryContentLevel;
    allowedFields: string[];
    throughSequence?: number;
    factPrefixFingerprint?: string;
    retentionPurpose?: string;
    revocationMethod?: string;
    grantedAt: string;
}

export declare interface TelemetryConfigurationFact {
    schemaVersion: 1;
    mode: TelemetryMode;
    contentLevel: TelemetryContentLevel;
    allowedFields: string[];
    configuredAt: string;
    endpointOrigin?: string;
}

export declare type TelemetryConfigurationSource = "default" | "configured" | "legacy_default";

export declare interface TelemetryConsentFact {
    schemaVersion: 1;
    scopeFingerprint: string;
    runId: string;
    consentId: string;
    kind: "feedback" | "content";
    targetOrigin: string;
    contentLevel: TelemetryContentLevel;
    allowedFields: string[];
    throughSequence?: number;
    factPrefixFingerprint?: string;
    retentionPurpose?: string;
    revocationMethod?: string;
    grantedAt: string;
}

export declare type TelemetryConsentInput = Omit<TelemetryConsentFact, "schemaVersion" | "scopeFingerprint">;

/** consent 只绑定发送范围，不把 UI 状态或授权时间混入范围身份。 */
export declare function telemetryConsentScopeFingerprint(input: Pick<TelemetryConsentFact, "runId" | "kind" | "targetOrigin" | "contentLevel" | "allowedFields" | "throughSequence" | "factPrefixFingerprint" | "retentionPurpose" | "revocationMethod">): string;

export declare type TelemetryContentLevel = "metrics_only" | "content";

export declare interface TelemetryDeliveryProjection {
    mode: TelemetryMode;
    exporterLoaded: boolean;
    endpointOrigin?: string;
    contentLevel: TelemetryContentLevel;
    allowedFields: string[];
    queued: number;
    handedOff: number;
    failed: number;
    dropped: number;
    duplicates: number;
    shutdownTimedOut: boolean;
    lastFailure?: TelemetryFailureCode;
}

export declare interface TelemetryEgressAuthorization {
    schemaVersion: 1;
    targetOrigin: string;
    resolvedAddresses: string[];
    redirectPolicy: "deny";
    proxyPolicy: "deny";
    tlsPolicy: "strict";
    policyFingerprint: string;
}

/**
 * 可丢弃的 Telemetry 投影器。它只消费已经持久化的 Facts，且永远不写回运行事实。
 */
export declare class TelemetryEgressController {
    private readonly options;
    constructor(options: TelemetryEgressControllerOptions);
    export(records: readonly RunStateRecord[]): Promise<TelemetryDeliveryProjection>;
}

export declare interface TelemetryEgressControllerOptions {
    policy: TelemetryPolicy;
    createExporter?: (context: {
        endpointOrigin: string;
        authorization: TelemetryEgressAuthorization;
        signal: AbortSignal;
        credentials?: Readonly<Record<string, string>>;
    }) => TelemetryExporter | Promise<TelemetryExporter>;
    authorizeEgress?: (context: {
        endpointOrigin: string;
        signal: AbortSignal;
    }) => TelemetryEgressAuthorization | Promise<TelemetryEgressAuthorization>;
    readCredentials?: (signal: AbortSignal) => Promise<Record<string, string>>;
    queueLimit?: number;
    exportTimeoutMs?: number;
    shutdownTimeoutMs?: number;
    redact?: (value: unknown) => unknown;
}

export declare interface TelemetryExporter {
    export(record: TelemetryExportRecord, context: {
        authorization: TelemetryEgressAuthorization;
        signal: AbortSignal;
    }): void | Promise<void>;
    shutdown?(context: {
        signal: AbortSignal;
    }): void | Promise<void>;
}

export declare class TelemetryExporterError extends Error {
    readonly code: TelemetryFailureCode;
    constructor(code: TelemetryFailureCode, message: string);
}

export declare interface TelemetryExportRecord {
    identity: string;
    runId: string;
    sequence: number;
    timestamp: string;
    kind: RunStateKind;
    eventType?: string;
    fields: Readonly<Record<string, unknown>>;
}

/** 把 feedback 授权绑定到同一 Run 当时已持久化的精确 Fact 前缀。 */
export declare function telemetryFactPrefixFingerprint(records: readonly RunStateRecord[], throughSequence: number): string;

export declare type TelemetryFailureCode = "dns" | "tls" | "http_401" | "http_429" | "timeout" | "exporter_failed" | "exporter_unavailable" | "egress_policy_missing" | "egress_policy_denied" | "configuration_mismatch" | "feedback_consent_missing" | "content_consent_missing" | "redaction_failed";

export declare type TelemetryMode = "DISABLED" | "FEEDBACK_ONLY" | "FULL";

export declare interface TelemetryPolicy {
    mode: TelemetryMode;
    endpoint?: string;
    contentLevel?: TelemetryContentLevel;
    allowedFields?: string[];
}

export declare const TOOL_CALL_PHASES: readonly ["call_recorded", "capability_resolved", "policy_resolved", "approval_resolved", "lease_acquired", "checkpoint_durable", "started_durable", "executing", "observed", "result_durable", "terminal"];

export declare interface ToolApprovalRequest {
    approvalId: string;
    runId: string;
    agent: string;
    tool: string;
    args: unknown;
    risk: ToolRisk;
    reason: string;
    effect: ToolEffect;
    capability?: ResolvedToolCapability;
}

export declare interface ToolCallIdentity {
    agent: string;
    callId: string;
    stepId?: string;
}

export declare interface ToolCallLifecycleFact {
    type: "tool_lifecycle";
    agent: string;
    callId: string;
    tool: string;
    stepId?: string;
    turnId?: string;
    resolution: ToolCallPhaseResolution;
}

export declare interface ToolCallLifecycleState {
    version: 1;
    agent: string;
    callId: string;
    tool: string;
    stepId?: string;
    currentPhase: ToolCallPhase;
    terminal: boolean;
    phases: ToolCallPhaseResolution[];
    result: ToolCallResultAxes;
}

export declare type ToolCallPhase = (typeof TOOL_CALL_PHASES)[number];

export declare type ToolCallPhaseResolution = ({
    phase: ToolCallPhase;
    status: "completed";
} | {
    phase: ToolCallPhase;
    status: "skipped" | "failed";
    reason: string;
}) & {
    result?: Partial<ToolCallResultAxes>;
};

export declare interface ToolCallResultAxes {
    executionOutcome: ExecutionOutcome;
    effectState: EffectState;
    persistenceState: PersistenceState;
    recoveryDisposition: RecoveryDisposition;
    cleanupState: CleanupState;
    authorizationState: AuthorizationState;
    environmentState: EnvironmentState;
}

export declare interface ToolCapabilityProjection {
    agent: string;
    callId?: string;
    stepId?: string;
    tool: string;
    capability: ResolvedToolCapability;
    recoveryDisposition: RecoveryDisposition;
    provenance: "current" | "legacy";
}

export declare interface ToolEffect {
    operations: ToolEffectOperation[];
    paths: string[];
    urls: string[];
    reversible: boolean;
    declared: boolean;
}

/** 所有 Call 入口共用的生命周期写入与投影 seam。 */
export declare class ToolExecutionEngine {
    private readonly options;
    private readonly states;
    private readonly pendingByCall;
    private readonly adapterInvoked;
    constructor(options: ToolExecutionEngineOptions);
    recordCall(input: ToolCallIdentity & {
        tool: string;
    }): Promise<ToolCallLifecycleState>;
    private recordCallUnqueued;
    advance(identity: ToolCallIdentity, resolution: ToolCallPhaseResolution): Promise<ToolCallLifecycleState>;
    /** 唯一 Tool Adapter 调用入口：只有已完成 executing 门禁的 Call 可执行一次。 */
    executeAdapter<T>(identity: ToolCallIdentity, execute: () => Promise<T> | T): Promise<T>;
    private trackPending;
    blockBeforeExecution(identity: ToolCallIdentity, reason: string): Promise<ToolCallLifecycleState>;
    /** 在 Tool Result 已落盘后收敛正常 Call。 */
    finalizeResult(identity: ToolCallIdentity): Promise<ToolCallLifecycleState>;
    /** Tool 已返回但结果 barrier 失败：保留执行与 Effect 事实，只收敛持久化失败。 */
    failResultDurability(identity: ToolCallIdentity, reason: string): Promise<ToolCallLifecycleState>;
    /** 在 Run 取消或超时时，把所有开放 Call 收敛为单一、不可改写的终态。 */
    settleInterrupted(executionOutcome: Extract<ExecutionOutcome, "aborted" | "timed_out">, reason: string): Promise<void>;
    private settleOneInterrupted;
    private advanceUnqueued;
    inspect(identity: ToolCallIdentity): ToolCallLifecycleState | undefined;
}

export declare interface ToolExecutionEngineOptions {
    persist: (fact: ToolCallLifecycleFact) => Promise<void>;
}

/** 工具执行证据不保存命令原文，只保留退出码、耗时与不可逆摘要。 */
declare interface ToolExecutionEvidence {
    durationMs: number;
    exitCode: number | null;
    commandSha256?: string;
    testCommand?: boolean;
}

/** 三档权限的唯一判定点；显式 deny 和工作区边界始终优先。 */
export declare class ToolPolicy {
    private readonly options;
    private readonly permissions;
    constructor(options: ToolPolicyOptions);
    authorize(agent: string, tool: string, args: unknown, capabilityOrDeclaration?: ResolvedToolCapability | ToolEffectDeclaration, selectors?: ToolEffectDeclaration): Promise<ToolPolicyDecision>;
    private findEscapedPath;
}

export declare interface ToolPolicyDecision {
    allowed: boolean;
    reason: string;
    approvalId?: string;
    approvedBy?: "configuration" | "mode" | "user";
}

declare interface ToolPolicyOptions {
    permissions?: PermissionsConfig;
    cwd: string;
    runId: string;
    approve?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
    createApprovalId: () => string;
    platform?: NodeJS.Platform;
    onApprovalRequired?: (request: ToolApprovalRequest) => void;
    onApprovalResolved?: (request: ToolApprovalRequest, decision: ApprovalDecision) => void;
}

export declare interface ToolReplayCandidate {
    previousReceiptId: string;
    previousCallId: string;
    attempt: number;
    agent: string;
    tool: string;
    stepId?: string;
    argumentsFingerprint: string;
    capabilityFingerprint: string;
}

export declare type ToolRisk = "low" | "high";

export declare class TraceRecorder {
    readonly runId: string;
    private readonly forward?;
    private sequence;
    readonly entries: CoreMindTraceEvent[];
    constructor(runId: string, forward?: ((entry: CoreMindTraceEvent) => void) | undefined, initialEntries?: CoreMindTraceEvent[]);
    record(event: CoreMindEvent): CoreMindTraceEvent;
}

export declare interface TrajectoryGrader extends GraderBase {
    type: "trajectory";
    sequence: TrajectoryStep[];
    forbiddenTools?: string[];
    maxToolFailures?: number;
}

export declare interface TrajectoryStep {
    tool: string;
    argsContains?: string;
    result?: "succeeded" | "failed";
}

export declare interface TransientRetryOptions {
    maxRetries: number;
    signal?: AbortSignal;
    onRetry?: (attempt: number, error: unknown) => void;
}

export declare function validateEvaluationSuite(value: unknown): EvaluationSuite;

export declare function validateTelemetryConfigurationFact(value: unknown): TelemetryConfigurationFact;

/** 在写入前验证 consent 只覆盖同一 Run 已经 durable 的 Fact 高水位。 */
export declare function validateTelemetryConsentBinding(value: unknown, persistedRecords: readonly RunStateRecord[]): TelemetryConsentFact;

export declare function validateTelemetryConsentFact(value: unknown): TelemetryConsentFact;

export declare function validateToolCallLifecycleFact(value: unknown): ToolCallLifecycleFact;

export declare interface WorkspaceLeaseAcquireOptions {
    workspaceRoot: string;
    lane: ToolCapabilityConcurrency;
    owner: WorkspaceLeaseOwnerInput;
}

export declare interface WorkspaceLeaseHandle {
    readonly canonicalRoot: string;
    readonly lane: ToolCapabilityConcurrency;
    readonly owner: WorkspaceLeaseOwner;
    readonly requiresWriteLease: boolean;
    release(quiescence: WorkspaceQuiescence): Promise<void>;
    rollbackBeforeExecution(): Promise<void>;
}

export declare type WorkspaceLeaseInspection = {
    state: "available";
    canonicalRoot: string;
} | {
    state: "held";
    canonicalRoot: string;
    owner: WorkspaceLeaseOwner;
} | {
    state: "recovery_required";
    canonicalRoot: string;
    owner?: WorkspaceLeaseOwner;
    reason: string;
};

export declare interface WorkspaceLeaseOwner extends WorkspaceLeaseOwnerInput {
    schemaVersion: 1;
    canonicalRoot: string;
    pid: number;
    nonce: string;
    acquiredAt: string;
}

export declare interface WorkspaceLeaseOwnerInput {
    runId: string;
    callId: string;
}

export declare function workspaceLeasePath(canonicalRoot: string): string;

export declare interface WorkspaceLeaseProjection {
    agent: string;
    callId: string;
    stepId?: string;
    canonicalRoot: string;
    lane: ToolCapabilityConcurrency;
    owner: {
        runId: string;
        callId: string;
        pid: number;
    };
    status: "acquired" | "released" | "recovery_required";
}

export declare interface WorkspaceLeaseRecoveryDecision {
    state: "recovered";
    canonicalRoot: string;
    previousOwner: WorkspaceLeaseOwner;
    recoveredAt: string;
}

/** 本地文件系统 Workspace 单写者服务；不声称网络文件系统或远程分布式一致性。 */
export declare class WorkspaceLeaseService {
    private readonly runSerialOwners;
    acquire(options: WorkspaceLeaseAcquireOptions): Promise<WorkspaceLeaseHandle>;
    inspect(workspaceRoot: string): Promise<WorkspaceLeaseInspection>;
    recover(workspaceRoot: string, expectedOwnerNonce: string): Promise<WorkspaceLeaseRecoveryDecision>;
    private acquireRunSerial;
    private fileLease;
    private inspectCanonical;
}

export declare interface WorkspaceQuiescence {
    activeTools: number;
    activeProcesses: number;
    pendingCriticalFacts: number;
}

export { }
