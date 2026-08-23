import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AfterToolCallContext,
  Agent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
} from "@earendil-works/pi-agent-core";
import type { AgentConfig, CoreMindConfig, ToolEffectDeclaration } from "coremind-config";
import { loadDirectorySkills, resolveSkills, SKILLS } from "coremind-templates";
import {
  type ArtifactRecord,
  ArtifactStore,
  buildTools,
  extractArtifactRecord,
  inferLegacyToolCapability,
  type ResolvedToolCapability,
  recoveryDispositionFor,
  resolveToolCapability,
  wrapToolWithArtifactCapture,
} from "coremind-tools";
import { type AgentBuildContext, buildAgent } from "./agent-factory.js";
import { RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import {
  type CheckpointDiff,
  CheckpointManager,
  type CheckpointRecord,
  inspectCheckpoint as inspectStoredCheckpoint,
  restoreCheckpoint as restoreStoredCheckpoint,
} from "./checkpoint.js";
import {
  assessRuntimeEngineeringEvidence,
  createToolExecutionEvidence,
} from "./coding/runtime-engineering-evidence.js";
import { type BranchMessage, projectBranchMessages } from "./compaction-projection.js";
import { ContextProtector } from "./context.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractAgentError, extractText } from "./events.js";
import { type RunId, receiptId } from "./ids.js";
import {
  claimInput,
  completeInput,
  createInputReceipt,
  discardInput,
  type InputId,
  inputFingerprint,
  newInputId,
  receiptStatusOf,
} from "./input-receipt.js";
import {
  LifecycleExtensionHost,
  type LifecycleExtensionPolicy,
  type LifecycleExtensionReceipt,
} from "./lifecycle-extension.js";
import { LoopRunner, type LoopStepRequest } from "./loop-runner.js";
import {
  DurableOperation,
  type DurableOperationSnapshot,
  type OperationEvent,
  restoreDurableOperation,
} from "./operation-state.js";
import { Orchestrator, type StepOutput } from "./orchestrator.js";
import { buildProviderRuntime, type ProviderRuntime } from "./provider.js";
import type { CoreMindMessage } from "./public-message.js";
import { adaptCoreMindTool, type CoreMindToolDefinition } from "./public-tool.js";
import {
  analyzeRunMetrics,
  assessReleaseReadiness,
  createEvaluationReport,
  type EvaluationReport,
  type ReleaseReadiness,
  type RunMetrics,
  type RunOutcome,
} from "./result.js";
import { classifyRetry, runWithTransientRetry } from "./retry-policy.js";
import { RunEffectCoordinator } from "./run-effect-coordinator.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  hasPendingJournalFlush,
  prepareRunResume,
  RunStateJournal,
  type RunStore,
} from "./run-state.js";
import { RunTerminalizer } from "./run-terminalizer.js";
import { CoreMindSession } from "./session.js";
import { createRunSnapshot, type RunSnapshot } from "./snapshot.js";
import { type ToolCallIdentity, ToolExecutionEngine } from "./tool-call-lifecycle.js";
import { toolCapabilityCallKey } from "./tool-capability-identity.js";
import { type ApprovalDecision, type ToolApprovalRequest, ToolPolicy } from "./tool-policy.js";
import { type CoreMindTraceEvent, TraceRecorder } from "./trace.js";
import { TurnTracker } from "./turn-tracker.js";

type RuntimeHarness = NonNullable<AgentBuildContext["harness"]> & {
  shouldStopAfterTurn?: NonNullable<Agent["shouldStopAfterTurn"]>;
  throwIfDenied?: () => void;
};

export interface CoreMindRuntimeOptions {
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
  /** 通过稳定 CoreMind 契约注入的 TypeScript 或跨语言工具。 */
  toolDefinitions?: CoreMindToolDefinition[];
  /** 显式注册、信任并授权的进程内生命周期扩展；不会扫描项目目录。 */
  lifecycleExtensions?: LifecycleExtensionPolicy;
  signal?: AbortSignal;
  /** 会话 id：落盘文件名标识（断点续聊恢复二期提供） */
  sessionId?: string;
  /** 工作流总步骤上限（护栏，默认 100） */
  maxSteps?: number;
  /** 单步骤超时毫秒（护栏，默认 300000 = 5 分钟；0 = 不超时） */
  stepTimeoutMs?: number;
}

export interface RunResult {
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
}

/**
 * CoreMind 运行时门面：配置 → provider/工具/agent → 执行。
 * 库形式嵌入入口：buildAgentFromConfig / CoreMindRuntime.create().run()
 */
export class CoreMindRuntime {
  /** 最近创建的每个 agent 实例（收集最终消息/落盘用） */
  private readonly lastAgents = new Map<string, Agent>();
  /** 恢复的会话上下文消息数（0 = 未恢复） */
  readonly resumedContextLength: number;
  /** 主 agent 名（会话归属） */
  private readonly mainAgentName: string;
  /** 恢复视图（作为主 agent 初始消息） */
  private readonly sessionMessages?: AgentMessage[];
  /** agent 名 → 注入的技能内容 */
  private readonly skillsByAgent: Map<string, string[]>;
  private activeHarnessFactory?: (agentName: string, stepId?: string) => RuntimeHarness;
  /** 并发 run() 检测（R7）：进行中的 run promise */
  private activeRunPromise?: Promise<RunResult>;
  /** 当前 run 的 journal（persistSession 的准入/abort 语义用） */
  private runJournal?: RunStateJournal;
  /** 本次 run 打开的会话（压缩条目落盘与 persist 复用同一句柄） */
  private activeSession?: CoreMindSession;
  /** 会话树已落盘视图消息 + 来源条目 id（压缩替换范围的桥接） */
  private sessionBranch?: BranchMessage[];
  /** 压缩后 agent 消息数组中被会话树代表的前缀长度（persist 跳过，避免重复落盘） */
  private compactedPrefixEnd?: number;

  private constructor(
    private readonly config: CoreMindConfig,
    private readonly agentConfigs: Map<string, AgentConfig>,
    private readonly toolsByAgent: Map<string, AgentTool[]>,
    private readonly toolEffectsByAgent: Map<string, Map<string, ToolEffectDeclaration>>,
    private readonly toolCapabilitiesByAgent: Map<string, Map<string, ResolvedToolCapability>>,
    private readonly providerRuntime: ProviderRuntime,
    private readonly options: CoreMindRuntimeOptions,
    sessionMessages: AgentMessage[] | undefined,
    resumedContextLength: number,
    skillsByAgent: Map<string, string[]>,
  ) {
    this.sessionMessages = sessionMessages;
    this.resumedContextLength = resumedContextLength;
    this.mainAgentName = config.defaultAgent ?? firstKey(config.agents) ?? "";
    this.skillsByAgent = skillsByAgent;
  }

  /** 由配置构建运行时（注册 provider、构建工具与全部 agent 定义） */
  static async create(options: CoreMindRuntimeOptions): Promise<CoreMindRuntime> {
    const { config, configDir } = options;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    const emit = options.events ?? (() => {});

    // 1. provider（解析模型，警告转发）
    const providerRuntime = await buildProviderRuntime(config.provider, env);
    for (const warning of providerRuntime.warnings) {
      emit({ type: "error", message: warning, fatal: false });
    }

    // 2. 每个 agent：构建工具与技能（Agent 实例按需创建，避免并发冲突）
    const agentConfigs = new Map<string, AgentConfig>();
    const toolsByAgent = new Map<string, AgentTool[]>();
    const toolEffectsByAgent = new Map<string, Map<string, ToolEffectDeclaration>>();
    const toolCapabilitiesByAgent = new Map<string, Map<string, ResolvedToolCapability>>();
    const skillsByAgent = new Map<string, string[]>();
    const artifactStore = new ArtifactStore({ cwd });
    const externalTools = (options.toolDefinitions ?? []).map((definition) =>
      wrapToolWithArtifactCapture(adaptCoreMindTool(definition), artifactStore),
    );
    // 自定义技能（生态机制）：配置文件所在目录的 skills/ 下，每个子目录的 README.md 即一个技能
    const customSkills = await loadDirectorySkills(path.join(configDir, "skills"));
    for (const [name, agentCfg] of Object.entries(config.agents)) {
      const toolConfigs = (agentCfg.tools?.length ?? 0) > 0 ? agentCfg.tools : config.tools;
      const { tools, warnings, effects, capabilities } = await buildTools(toolConfigs ?? [], {
        cwd,
        configDir,
        env,
        artifactStore,
      });
      for (const warning of warnings) {
        emit({ type: "error", message: warning, fatal: false });
      }
      agentConfigs.set(name, agentCfg);
      toolsByAgent.set(name, [...tools, ...externalTools]);
      toolEffectsByAgent.set(
        name,
        new Map([
          ...effects,
          ...(options.toolDefinitions ?? []).map(
            (definition) => [definition.name, definition.effect] as const,
          ),
        ]),
      );
      toolCapabilitiesByAgent.set(
        name,
        new Map([
          ...capabilities,
          ...(options.toolDefinitions ?? []).map(
            (definition) =>
              [
                definition.name,
                definition.capability
                  ? resolveToolCapability({
                      tool: definition.name,
                      source: "registered",
                      declaration: definition.capability,
                    })
                  : inferLegacyToolCapability(definition.name, definition.effect),
              ] as const,
          ),
        ]),
      );

      // 技能：内置优先，未命中的查自定义目录，仍缺失才告警（不阻断）
      const { contents, missing } = resolveSkills(agentCfg.skills ?? []);
      const allContents = [...contents];
      for (const id of missing) {
        const custom = customSkills.get(id);
        if (custom) {
          allContents.push(custom);
        } else {
          emit({
            type: "error",
            message: `技能 ${id} 不存在（内置：${SKILLS.map((s) => s.id).join("、")}；自定义：放配置目录的 skills/${id}/README.md），已忽略`,
            fatal: false,
          });
        }
      }
      skillsByAgent.set(name, allContents);
    }

    // 会话恢复：--session 且 session.enabled 时，打开已有会话注入历史视图（非破坏）
    let sessionMessages: AgentMessage[] | undefined;
    let resumedContextLength = 0;
    if (options.sessionId && config.session?.enabled) {
      const dir = sessionDir(config, configDir);
      try {
        if (await CoreMindSession.exists(dir, options.sessionId, cwd)) {
          const cm = await CoreMindSession.open({ dir, sessionId: options.sessionId, cwd });
          const ctx = await cm.buildContext();
          if (ctx.messages.length > 0) {
            sessionMessages = ctx.messages;
            resumedContextLength = ctx.messages.length;
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CoreMindError(
          "session_restore_failed",
          `会话 ${options.sessionId} 恢复失败：${detail}`,
        );
      }
    }
    return new CoreMindRuntime(
      config,
      agentConfigs,
      toolsByAgent,
      toolEffectsByAgent,
      toolCapabilitiesByAgent,
      providerRuntime,
      options,
      sessionMessages,
      resumedContextLength,
      skillsByAgent,
    );
  }

  /** 按名字创建独立 Agent 实例（每次新实例，消息历史独立） */
  private createAgent(
    name: string,
    onEvent: (event: CoreMindEvent) => void = this.options.events ?? (() => {}),
    stepId?: string,
  ): Agent | undefined {
    const agentCfg = this.agentConfigs.get(name);
    if (!agentCfg) return undefined;
    const harness = this.activeHarnessFactory?.(name, stepId);
    const agent = buildAgent(agentCfg, {
      models: this.providerRuntime.models,
      model: this.providerRuntime.model,
      tools: this.toolsByAgent.get(name) ?? [],
      agentName: name,
      onEvent,
      apiKeyOverride: this.providerRuntime.apiKeyOverride,
      // 恢复视图只注入主 agent（会话归属者）
      sessionMessages: name === this.mainAgentName ? this.sessionMessages : undefined,
      skillsContent: this.skillsByAgent.get(name),
      stableFacts: {
        provider: this.providerRuntime.model.provider,
        model: this.providerRuntime.model.id,
        contextWindow: this.providerRuntime.model.contextWindow,
      },
      promptCacheStatus: this.providerRuntime.promptCacheStatus,
      harness,
    });
    // 该停止钩子只属于 Runtime 内部 Harness，不扩大公开 AgentBuildContext 合同。
    agent.shouldStopAfterTurn = harness?.shouldStopAfterTurn;
    if (harness?.throwIfDenied) {
      const waitForIdle = agent.waitForIdle.bind(agent);
      agent.waitForIdle = async () => {
        await waitForIdle();
        harness.throwIfDenied?.();
      };
    }
    this.lastAgents.set(name, agent);
    return agent;
  }

  /** 查询配置中是否存在 Agent，供交互会话在首轮前快速失败。 */
  hasAgent(name: string): boolean {
    return this.agentConfigs.has(name);
  }

  /** 返回交互会话应继承的恢复消息副本。 */
  initialMessagesFor(name: string): CoreMindMessage[] {
    return (name === this.mainAgentName
      ? [...(this.sessionMessages ?? [])]
      : []) as unknown as CoreMindMessage[];
  }

  /**
   * 把一轮交互对话作为完整 Run 执行。
   * 因此 chat/TUI 与无头 run 共用预算、权限、checkpoint、Trace 和失败语义。
   */
  async runAgentTurn(
    agentName: string,
    message: string,
    history: CoreMindMessage[],
    events: (event: CoreMindEvent) => void,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    if (!this.agentConfigs.has(agentName)) {
      throw new CoreMindError("unknown_agent", `配置中没有可用的 agent：${agentName}`);
    }
    const turnConfig: CoreMindConfig = { ...this.config, defaultAgent: agentName };
    delete turnConfig.workflow;
    const turnRuntime = new CoreMindRuntime(
      turnConfig,
      this.agentConfigs,
      this.toolsByAgent,
      this.toolEffectsByAgent,
      this.toolCapabilitiesByAgent,
      this.providerRuntime,
      {
        ...this.options,
        config: turnConfig,
        initialPrompt: message,
        events,
        signal,
      },
      history as unknown as AgentMessage[],
      history.length,
      this.skillsByAgent,
    );
    return turnRuntime.run();
  }

  inspectCheckpoint(record: CheckpointRecord): Promise<CheckpointDiff> {
    return inspectStoredCheckpoint(record, this.options.cwd ?? process.cwd());
  }

  restoreCheckpoint(record: CheckpointRecord): Promise<void> {
    return restoreStoredCheckpoint(record, this.options.cwd ?? process.cwd());
  }

  /** 执行：有 workflow 走编排，否则单 agent 直答。返回结果含质量摘要 */
  async run(): Promise<RunResult> {
    // R7：同一实例不支持并发 run()，运行时检测并明确报错（串行化属 0.3.x-B）
    if (this.activeRunPromise) {
      throw new CoreMindError("concurrent_run", "同一 Runtime 实例不支持并发 run()");
    }
    const promise = this.executeRunBody();
    this.activeRunPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.activeRunPromise === promise) this.activeRunPromise = undefined;
      this.runJournal = undefined;
    }
  }

  /** run() 主体（并发检测由外层 run() 包装） */
  private async executeRunBody(): Promise<RunResult> {
    const started = performance.now();
    const lifecycleHost = this.options.lifecycleExtensions
      ? new LifecycleExtensionHost(this.options.lifecycleExtensions)
      : undefined;
    const runStore =
      this.options.runStore ??
      new FileRunStore(path.join(this.options.configDir, ".coremind", "runs"));
    const configFingerprint = fingerprintRunConfig(this.config);
    // 会话树关联：打开会话拿 seq 水位与已落盘视图（压缩条目落盘与重建桥接用）
    let sessionSeqStart: number | undefined;
    if (this.options.sessionId && this.config.session?.enabled) {
      this.activeSession = await CoreMindSession.open({
        dir: sessionDir(this.config, this.options.configDir),
        sessionId: this.options.sessionId,
        cwd: this.options.cwd ?? process.cwd(),
      });
      sessionSeqStart = await this.activeSession.currentSeq();
      this.sessionBranch = projectBranchMessages(await this.activeSession.branchEntries());
    }
    const resumePlan = this.options.resumeRunId
      ? prepareRunResume(
          await runStore.read(this.options.resumeRunId),
          configFingerprint,
          this.options.initialPrompt,
        )
      : undefined;
    // 预生成 runId（D-1）：resume 时以恢复记录为准，否则优先使用调用方预生成值
    const runId: RunId = (resumePlan?.runId ?? this.options.runId ?? randomUUID()) as RunId;
    const effectiveInitialPrompt = resumePlan?.initialPrompt ?? this.options.initialPrompt;
    const journal = new RunStateJournal(runId, runStore, resumePlan?.nextJournalSequence ?? 0);
    this.runJournal = journal;
    const operation =
      resumePlan && resumePlan.operationRecords.length > 0
        ? restoreDurableOperation(resumePlan.operationRecords)
        : DurableOperation.create({
            runId,
            operationId: randomUUID(),
            eventId: randomUUID(),
          });
    const persistOperation = (event: OperationEvent): void => {
      const transition = operation.transition(event);
      if (transition.record) journal.operation(transition.record);
    };
    const initialOperationState = operation.snapshot().state;
    if (
      resumePlan &&
      initialOperationState !== "accepted" &&
      initialOperationState !== "running" &&
      initialOperationState !== "paused"
    ) {
      throw new CoreMindError(
        "operation_not_resumable",
        `操作 ${operation.snapshot().operationId} 处于 ${initialOperationState}，不能继续执行`,
      );
    }
    if (resumePlan) {
      journal.resume({
        completedStepIds: [...resumePlan.completedSteps.keys()],
        resumedAt: new Date().toISOString(),
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
        ...(sessionSeqStart !== undefined
          ? { sessionSeqStart, turnSeqStart: sessionSeqStart }
          : {}),
      });
    } else {
      await journal.start({
        configName: this.config.name,
        schemaVersion: this.config.schemaVersion,
        configFingerprint,
        initialPrompt: this.options.initialPrompt,
        sessionId: this.options.sessionId,
        ...(sessionSeqStart !== undefined
          ? { sessionSeqStart, turnSeqStart: sessionSeqStart }
          : {}),
        operationId: operation.snapshot().operationId,
      });
    }
    if (!resumePlan || resumePlan.operationRecords.length === 0) {
      journal.operation(operation.records()[0]!);
    }
    if (operation.snapshot().state === "running") {
      persistOperation({
        eventId: randomUUID(),
        type: "PAUSE",
        reason: "process_interrupted",
      });
    }
    if (operation.snapshot().state === "accepted") {
      persistOperation({ eventId: randomUUID(), type: "START" });
    } else if (operation.snapshot().state === "paused") {
      persistOperation({ eventId: randomUUID(), type: "RESUME" });
    } else {
      throw new CoreMindError(
        "operation_not_resumable",
        `操作 ${operation.snapshot().operationId} 处于 ${operation.snapshot().state}，不能继续执行`,
      );
    }
    await journal.flush();
    const trace = new TraceRecorder(
      runId,
      (entry) => {
        journal.event(entry);
        this.options.trace?.(entry);
      },
      resumePlan?.previousTrace,
    );
    const collected: CoreMindEvent[] = resumePlan?.previousTrace.map((entry) => entry.event) ?? [];
    const userEvents = this.options.events ?? (() => {});
    const extensionReceipts: LifecycleExtensionReceipt[] = [];
    const turnTracker = new TurnTracker();
    // 输入收据（规格 03 §4）：恢复时沿用原 run 的 inputId（收据链连续），否则新生成
    const inputId =
      effectiveInitialPrompt === undefined
        ? undefined
        : (resumedInputId(collected) ?? newInputId());
    // 收据状态由本 run 发出的事件推进（pending → claimed → completed/discarded）；
    // resume 时原 run 已登记（pending/claimed）则本 run 不重复登记与 claim（折叠不允许
    // pending→pending / claimed→claimed），仅收尾按终态推进
    const existingInputState =
      inputId === undefined ? undefined : receiptStatusOf(collected, inputId);
    let inputReceiptState: "pending" | "claimed" | "completed" | "discarded" | undefined =
      existingInputState ?? (inputId === undefined ? undefined : "pending");
    let onToolResultRecorded:
      | ((event: Extract<CoreMindEvent, { type: "tool_result" }>) => void)
      | undefined;
    const lifecycleFinalizers = new Set<Promise<void>>();
    let lifecycleFailure: CoreMindError | undefined;
    const emitInputEvent = (event: CoreMindEvent): void => {
      collected.push(event);
      trace.record(event);
      userEvents(event);
    };
    const recordEvent = (event: CoreMindEvent) => {
      const enriched = turnTracker.withTurnId(event);
      // 事件准入（规格 03 §3）：abort 后的迟到终态事实不入 trace/collected/回调（ADR：不入 Trace 或 journal）
      if (!journal.admitEvent(enriched)) return;
      collected.push(enriched);
      trace.record(enriched);
      userEvents(enriched);
      if (enriched.type === "tool_result") onToolResultRecorded?.(enriched);
      // 输入被首个 Turn 认领（规格 03 §4：claim 绑定 TurnId；resume 时已 claimed 不再重复）；
      // 排在 agent_start 之后，保证事件顺序：agent_start → input_claimed
      if (enriched.type === "agent_start" && inputReceiptState === "pending") {
        inputReceiptState = "claimed";
        emitInputEvent(claimInput({ inputId: inputId!, turnId: enriched.turnId! }));
      }
    };
    if (inputId !== undefined && existingInputState === undefined) {
      // headless initialPrompt / chat 每轮 message：Run start 时登记 pending 收据（带指纹，
      // 不落原文）；resume 沿用原收据不重复登记
      emitInputEvent(
        createInputReceipt({
          inputId,
          contentFingerprint: inputFingerprint(effectiveInitialPrompt!),
        }),
      );
    }
    const effectCoordinator = new RunEffectCoordinator(runId, recordEvent);
    const emit = (event: CoreMindEvent) => effectCoordinator.emit(event);
    const toolExecutionEngine = new ToolExecutionEngine({
      persist: async (fact) => {
        recordEvent(fact);
      },
    });
    onToolResultRecorded = (event) => {
      const recorded = toolExecutionEngine.inspect({
        ...toolCallIdentity(event.agent, event.stepId, event.callId!),
      });
      if (!recorded || recorded.tool !== event.tool) return;
      queueMicrotask(() => {
        const identity = toolCallIdentity(event.agent, event.stepId, event.callId!);
        const finalizer = (async () => {
          const lifecycle = toolExecutionEngine.inspect(identity);
          const capability = capabilityByCallId.get(
            toolCapabilityCallKey(event.agent, event.stepId, event.callId!),
          )?.capability;
          const durability =
            lifecycle?.result.executionOutcome === "not_invoked"
              ? "ordinary"
              : (capability?.durability ?? "critical");
          try {
            await journal.flush(durability);
            await toolExecutionEngine.finalizeResult(identity);
          } catch (error) {
            const failure =
              error instanceof CoreMindError
                ? error
                : new CoreMindError(
                    "durability_barrier_failed",
                    error instanceof Error ? error.message : String(error),
                  );
            if (toolExecutionEngine.inspect(identity)?.currentPhase === "observed") {
              await toolExecutionEngine.failResultDurability(identity, failure.message);
            }
            throw failure;
          }
        })();
        lifecycleFinalizers.add(finalizer);
        void finalizer
          .catch((error) => {
            lifecycleFailure =
              error instanceof CoreMindError
                ? error
                : new CoreMindError(
                    "tool_lifecycle_invalid",
                    error instanceof Error ? error.message : String(error),
                  );
          })
          .finally(() => lifecycleFinalizers.delete(finalizer));
      });
    };
    const dispatchLifecycle = async (
      lifecycle: Parameters<LifecycleExtensionHost["dispatch"]>[0],
      payload: Record<string, unknown>,
    ) => {
      if (!lifecycleHost) return undefined;
      const result = await lifecycleHost.dispatch(lifecycle, payload);
      for (const receipt of result.receipts) {
        extensionReceipts.push(receipt);
        emit({
          type: "extension_lifecycle",
          extensionId: receipt.extensionId,
          extensionVersion: receipt.extensionVersion,
          lifecycle: receipt.event,
          status: receipt.status,
          durationMs: receipt.durationMs,
          error: receipt.error,
          denied: receipt.denied,
        });
      }
      return result;
    };
    const workflow = this.config.workflow;
    const loop = this.config.loop;
    const limits = resolveRuntimeLimits(this.config.runtime, {
      maxSteps: this.options.maxSteps,
      stepTimeoutMs: this.options.stepTimeoutMs,
    });
    const budget = new RunBudgetController(limits, emit);
    for (const event of collected) budget.restore(event);
    const checkpointManager = new CheckpointManager({
      cwd: this.options.cwd ?? process.cwd(),
      rootDir: path.join(this.options.configDir, ".coremind", "checkpoints"),
      runId: trace.runId,
    });
    let checkpointFailure: CoreMindError | undefined;
    let capabilityFailure: CoreMindError | undefined;
    const artifacts: ArtifactRecord[] = [];
    const checkpointByCallId = new Map<string, string[]>();
    const capabilityByCallId = new Map<
      string,
      { tool: string; capability: ResolvedToolCapability }
    >();
    const contextWindow = this.providerRuntime.model.contextWindow;
    const contextProtector = new ContextProtector(
      {
        contextWindow,
        reserveTokens: Math.min(16_384, Math.max(1_024, Math.floor(contextWindow * 0.15))),
        keepRecentTokens: Math.min(20_000, Math.max(2_048, Math.floor(contextWindow * 0.25))),
      },
      async (result) => {
        let sessionEntryId: string | undefined;
        const range = result.replacedRange;
        const branch = this.sessionBranch;
        if (this.activeSession && branch && range && branch.length > 0) {
          // 替换范围延伸进本轮未落盘消息时，会话树内的范围终点截到已落盘末尾，
          // 未落盘尾部由 retainedTail 快照携带——重建依然无损（发送 = 摘要 + 保留区）。
          const coveredEnd = Math.min(range.end, branch.length);
          const summaryMessage = result.messages[0] as { content: string; timestamp: number };
          const entry = await this.activeSession.appendCompaction({
            summary: summaryMessage.content,
            retainedTail: result.messages.slice(1) as unknown as AgentMessage[],
            tokensBefore: result.beforeTokens,
            details: {
              fingerprint: result.summaryFingerprint!,
              rangeStartId: branch[range.start]!.entryId,
              rangeEndId: branch[coveredEnd - 1]!.entryId,
              summaryTimestamp: summaryMessage.timestamp,
            },
          });
          sessionEntryId = entry.id;
          // 更新已落盘视图：压缩产物（摘要 + 保留区）由该条目代表
          this.sessionBranch = [
            {
              message: result.messages[0]! as unknown as AgentMessage,
              entryId: entry.id,
              seq: entry.seq,
            },
            ...result.messages.slice(1).map((message) => ({
              message: message as unknown as AgentMessage,
              entryId: entry.id,
              seq: entry.seq,
            })),
          ];
          // persist 跳过压缩产物代表的部分：摘要 + 保留区（保留区=压缩后消息数-1，起点=range.end）
          this.compactedPrefixEnd = result.messages.length + range.end - 1;
        }
        emit({
          type: "context_compacted",
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          removedMessages: result.removedMessages,
          strategy: "deterministic-v1",
          reason: "threshold",
          summaryFingerprint: result.summaryFingerprint!,
          ...(sessionEntryId ? { sessionEntryId } : {}),
        });
      },
      (failure) =>
        emit({
          type: "context_compaction_failed",
          message: failure.message,
          preservedMessages: failure.preservedMessages,
        }),
    );
    const policy = new ToolPolicy({
      permissions: this.config.permissions,
      cwd: this.options.cwd ?? process.cwd(),
      runId: trace.runId,
      approve: this.options.approveTool,
      createApprovalId: randomUUID,
      onApprovalRequired: (request) =>
        emit({
          type: "approval_required",
          approvalId: request.approvalId,
          runId: request.runId,
          agent: request.agent,
          tool: request.tool,
          args: request.args,
          risk: request.risk,
          effect: request.effect,
          capability: request.capability,
        }),
      onApprovalResolved: (request, decision) =>
        emit({
          type: "approval_resolved",
          approvalId: request.approvalId,
          runId: request.runId,
          decision,
        }),
    });
    const deniedAgents = new Set<string>();
    this.activeHarnessFactory = (agentName, stepId) => ({
      maxRetries: loop ? 0 : limits.maxRetries,
      transformContext: async (messages) => {
        while (lifecycleFinalizers.size > 0) {
          await Promise.allSettled([...lifecycleFinalizers]);
        }
        if (lifecycleFailure) throw lifecycleFailure;
        await dispatchLifecycle("before-model", {
          runId,
          agent: agentName,
          stepId,
          messageCount: messages.length,
        });
        return (await contextProtector.transformAsync(messages)) as unknown as AgentMessage[];
      },
      beforeToolCall: async (context: BeforeToolCallContext) => {
        const lifecycleIdentity = toolCallIdentity(agentName, stepId, context.toolCall.id);
        const callKey = toolCapabilityCallKey(agentName, stepId, context.toolCall.id);
        const existingCapability = capabilityByCallId.get(callKey);
        if (existingCapability && existingCapability.tool !== context.toolCall.name) {
          capabilityFailure = new CoreMindError(
            "tool_capability_conflict",
            `Call ${agentName}/${stepId ?? "-"}/${context.toolCall.id} 从 ${existingCapability.tool} 变更为 ${context.toolCall.name}，Tool Capability 不可变`,
          );
          emit({ type: "error", message: capabilityFailure.message, fatal: true });
          return { block: true, reason: capabilityFailure.message };
        }
        await toolExecutionEngine.recordCall({
          ...lifecycleIdentity,
          tool: context.toolCall.name,
        });
        let capability = existingCapability?.capability;
        if (!existingCapability) {
          capability =
            this.toolCapabilitiesByAgent.get(agentName)?.get(context.toolCall.name) ??
            resolveToolCapability({ tool: context.toolCall.name });
          capabilityByCallId.set(callKey, {
            tool: context.toolCall.name,
            capability,
          });
          emit({
            type: "capability_resolved",
            agent: agentName,
            tool: context.toolCall.name,
            callId: context.toolCall.id,
            ...(stepId ? { stepId } : {}),
            capability,
            recoveryDisposition: recoveryDispositionFor(capability),
          });
        }
        if (!capability) {
          throw new CoreMindError(
            "tool_capability_conflict",
            `Call ${context.toolCall.id} 缺少已解析 Tool Capability`,
          );
        }
        const resolvedCapability = capability;
        await toolExecutionEngine.advance(lifecycleIdentity, {
          phase: "capability_resolved",
          status: "completed",
          result: { recoveryDisposition: recoveryDispositionFor(resolvedCapability) },
        });
        if (deniedAgents.has(agentName)) {
          const reason = "同一工具批次已有请求被拒绝";
          await toolExecutionEngine.blockBeforeExecution(lifecycleIdentity, reason);
          return { block: true, reason, terminate: true };
        }
        const blockedByBudget = budget.beforeToolCall();
        if (blockedByBudget) {
          await toolExecutionEngine.blockBeforeExecution(
            lifecycleIdentity,
            blockedByBudget.reason ?? "工具调用预算已阻断 Call",
          );
          return blockedByBudget;
        }
        const decision = await policy.authorize(
          agentName,
          context.toolCall.name,
          context.args,
          resolvedCapability,
          this.toolEffectsByAgent.get(agentName)?.get(context.toolCall.name),
        );
        await toolExecutionEngine.advance(lifecycleIdentity, {
          phase: "policy_resolved",
          status: "completed",
          result: {
            authorizationState: decision.allowed
              ? decision.approvedBy === "user"
                ? "approved"
                : "allowed"
              : "denied",
          },
        });
        if (!decision.allowed) {
          await toolExecutionEngine.advance(
            lifecycleIdentity,
            decision.approvalId
              ? { phase: "approval_resolved", status: "completed" }
              : {
                  phase: "approval_resolved",
                  status: "skipped",
                  reason: "Policy 在审批前拒绝 Call",
                },
          );
          if (decision.approvalId) {
            try {
              await journal.flush("critical");
            } catch (error) {
              checkpointFailure = durabilityFailure(error);
              await toolExecutionEngine.blockBeforeExecution(
                lifecycleIdentity,
                checkpointFailure.message,
              );
              emit({ type: "error", message: checkpointFailure.message, fatal: true });
              return { block: true, reason: checkpointFailure.message, terminate: true };
            }
          }
          await toolExecutionEngine.blockBeforeExecution(lifecycleIdentity, decision.reason);
          deniedAgents.add(agentName);
          emit({
            type: "policy_denied",
            agent: agentName,
            tool: context.toolCall.name,
            reason: decision.reason,
          });
          return { block: true, reason: decision.reason, terminate: true };
        }
        await toolExecutionEngine.advance(
          lifecycleIdentity,
          decision.approvedBy === "user"
            ? { phase: "approval_resolved", status: "completed" }
            : {
                phase: "approval_resolved",
                status: "skipped",
                reason: decision.reason,
              },
        );
        if (decision.approvedBy === "user") {
          try {
            await journal.flush("critical");
          } catch (error) {
            checkpointFailure = durabilityFailure(error);
            await toolExecutionEngine.blockBeforeExecution(
              lifecycleIdentity,
              checkpointFailure.message,
            );
            emit({ type: "error", message: checkpointFailure.message, fatal: true });
            return { block: true, reason: checkpointFailure.message, terminate: true };
          }
        }
        const extensionDecision = await dispatchLifecycle("before-tool", {
          runId,
          agent: agentName,
          stepId,
          tool: context.toolCall.name,
          callId: context.toolCall.id,
          args: context.args,
          approvalAllowed: true,
        });
        if (extensionDecision?.denied) {
          deniedAgents.add(agentName);
          const reason = extensionDecision.denied.reason;
          emit({
            type: "policy_denied",
            agent: agentName,
            tool: context.toolCall.name,
            reason,
          });
          await toolExecutionEngine.blockBeforeExecution(lifecycleIdentity, reason);
          return { block: true, reason, terminate: true };
        }
        await toolExecutionEngine.advance(lifecycleIdentity, {
          phase: "lease_acquired",
          status: "skipped",
          reason:
            resolvedCapability.concurrency === "parallel"
              ? "Pure Local Read 不需要 Workspace Lease"
              : "Workspace Lease 由后续 Gate 接入",
        });
        try {
          const idempotencyKey = receiptId(runId, stepId, context.toolCall.id);
          const checkpoints = await checkpointManager.captureAll(
            context.toolCall.name,
            context.args,
            {
              operationId: operation.snapshot().operationId,
              toolCallId: context.toolCall.id,
              idempotencyKey,
              capability: resolvedCapability,
              pathFields: this.toolEffectsByAgent.get(agentName)?.get(context.toolCall.name)
                ?.pathFields,
            },
          );
          if (checkpoints.length > 0) {
            checkpointByCallId.set(
              context.toolCall.id,
              checkpoints.map((checkpoint) => checkpoint.checkpointId),
            );
            for (const checkpoint of checkpoints) {
              journal.checkpoint(checkpoint);
              emit({
                type: "checkpoint_created",
                checkpointId: checkpoint.checkpointId,
                tool: checkpoint.tool,
                callId: context.toolCall.id,
                idempotencyKey,
                targetPath: checkpoint.targetPath,
                reversible: checkpoint.reversible,
              });
            }
            await journal.flush("critical");
            await toolExecutionEngine.advance(lifecycleIdentity, {
              phase: "checkpoint_durable",
              status: "completed",
            });
          } else {
            await toolExecutionEngine.advance(lifecycleIdentity, {
              phase: "checkpoint_durable",
              status: "skipped",
              reason: "Tool Capability 不要求 Workspace Checkpoint",
            });
          }
        } catch (error) {
          checkpointFailure =
            error instanceof CoreMindError
              ? error
              : new CoreMindError(
                  "checkpoint_failed",
                  error instanceof Error ? error.message : String(error),
                );
          await toolExecutionEngine.advance(lifecycleIdentity, {
            phase: "checkpoint_durable",
            status: "failed",
            reason: checkpointFailure.message,
          });
          await toolExecutionEngine.blockBeforeExecution(
            lifecycleIdentity,
            checkpointFailure.message,
          );
          emit({ type: "error", message: checkpointFailure.message, fatal: true });
          return { block: true, reason: checkpointFailure.message };
        }
        effectCoordinator.markStarted(stepId, context.toolCall.id, context.toolCall.name);
        if (resolvedCapability.durability === "critical") {
          try {
            await journal.flush("critical");
            await toolExecutionEngine.advance(lifecycleIdentity, {
              phase: "started_durable",
              status: "completed",
              result: {
                effectState: resolvedCapability.effect === "none" ? "not_started" : "started",
                cleanupState: resolvedCapability.effect === "none" ? "not_needed" : "pending",
              },
            });
          } catch (error) {
            checkpointFailure = durabilityFailure(error);
            await toolExecutionEngine.advance(lifecycleIdentity, {
              phase: "started_durable",
              status: "failed",
              reason: checkpointFailure.message,
            });
            await toolExecutionEngine.blockBeforeExecution(
              lifecycleIdentity,
              checkpointFailure.message,
            );
            emit({ type: "error", message: checkpointFailure.message, fatal: true });
            return { block: true, reason: checkpointFailure.message };
          }
        } else {
          await toolExecutionEngine.advance(lifecycleIdentity, {
            phase: "started_durable",
            status: "skipped",
            reason: "Pure Local Read 不需要 started Durability Barrier",
          });
        }
        await toolExecutionEngine.advance(lifecycleIdentity, {
          phase: "executing",
          status: "completed",
        });
        return undefined;
      },
      afterToolCall: async (context: AfterToolCallContext) => {
        const lifecycleIdentity = toolCallIdentity(agentName, stepId, context.toolCall.id);
        const capability = capabilityByCallId.get(
          toolCapabilityCallKey(agentName, stepId, context.toolCall.id),
        )?.capability;
        await toolExecutionEngine.advance(lifecycleIdentity, {
          phase: "observed",
          status: "completed",
          result: {
            executionOutcome: context.isError ? "threw" : "returned",
            effectState:
              capability?.effect === "none"
                ? "not_started"
                : context.isError
                  ? "unknown"
                  : "committed",
            cleanupState: capability?.effect === "none" ? "not_needed" : "pending",
          },
        });
        const execution = createToolExecutionEvidence({
          tool: context.toolCall.name,
          args: context.args,
          isError: context.isError,
          result: context.result,
          durationMs: effectCoordinator.consumeDuration(stepId, context.toolCall.id),
        });
        emit({
          type: "tool_execution_evidence",
          agent: agentName,
          tool: context.toolCall.name,
          callId: context.toolCall.id,
          ...(stepId ? { stepId } : {}),
          execution,
        });
        const artifact = extractArtifactRecord(context.result.details);
        if (artifact) {
          artifacts.push(artifact);
          emit({
            type: "artifact_created",
            artifactId: artifact.artifactId,
            status: artifact.status,
            sizeBytes: artifact.sizeBytes,
            relativePath: artifact.relativePath,
            sha256: artifact.sha256,
            mediaType: artifact.mediaType,
            redaction: artifact.redaction,
            tool: context.toolCall.name,
            callId: context.toolCall.id,
          });
        }
        const checkpointIds = checkpointByCallId.get(context.toolCall.id);
        const checkpointId = checkpointIds?.[0];
        checkpointByCallId.delete(context.toolCall.id);
        if (checkpointIds) {
          try {
            await Promise.all(
              checkpointIds.map((storedCheckpointId) =>
                checkpointManager.markApplied(storedCheckpointId),
              ),
            );
          } catch (error) {
            checkpointFailure =
              error instanceof CoreMindError
                ? error
                : new CoreMindError(
                    "checkpoint_failed",
                    error instanceof Error ? error.message : String(error),
                  );
            emit({ type: "error", message: checkpointFailure.message, fatal: true });
          }
        }
        const budgetResult = budget.afterToolCall(context.isError);
        await dispatchLifecycle("after-tool", {
          runId,
          agent: agentName,
          stepId,
          tool: context.toolCall.name,
          callId: context.toolCall.id,
          isError: context.isError,
          checkpointId,
          artifactId: artifact?.artifactId,
        });
        return checkpointFailure ? { terminate: true } : budgetResult;
      },
      shouldStopAfterTurn: () => deniedAgents.has(agentName),
      throwIfDenied: () => {
        if (deniedAgents.has(agentName)) {
          throw new CoreMindError(
            "loop_paused",
            stepId ? `步骤 ${stepId} 的工具请求未获批准` : `Agent ${agentName} 的工具请求未获批准`,
          );
        }
      },
      onAgentEvent: (event, agent) => {
        if (budget.observeAgentEvent(event)) agent.abort();
      },
    });

    let outputs = new Map<string, StepOutput>();
    let transcript = "";
    let terminalError: unknown;
    let loopSnapshot = resumePlan?.loopSnapshot;
    let activeLoopRunner: LoopRunner | undefined;
    try {
      ({ outputs, transcript } = await this.runWithGuard(
        limits.runTimeoutMs,
        journal,
        () => knownTurnIdsFrom(collected),
        async () => {
          if (loop) {
            let retryCount =
              resumePlan?.previousTrace.filter(
                (entry) => entry.event.type === "retry" && entry.event.scope === "provider",
              ).length ?? 0;
            const runner = new LoopRunner({
              runId,
              configFingerprint,
              initialPrompt: effectiveInitialPrompt,
              loop,
              completedSteps: resumePlan?.completedSteps,
              restoredSnapshot: resumePlan?.loopSnapshot,
              emit,
              persistSnapshot: async (snapshot) => {
                loopSnapshot = snapshot;
                journal.loop(snapshot);
                await journal.flush();
              },
              verifyEvidence: loop.verify.evidence
                ? ({ stepId, textPassed }) => {
                    const report = assessRuntimeEngineeringEvidence(
                      collected,
                      loop.verify.evidence!,
                      stepId,
                    );
                    emit({ type: "engineering_evidence", stepId, textPassed, ...report });
                    return report.passed;
                  }
                : undefined,
              executeStep: (request) =>
                runWithTransientRetry(
                  () => this.executeLoopStep(request, emit, limits.stepTimeoutMs, collected),
                  {
                    maxRetries: Math.max(0, limits.maxRetries - retryCount),
                    signal: this.options.signal,
                    onRetry: () => {
                      retryCount += 1;
                      emit({
                        type: "retry",
                        scope: "provider",
                        attempt: retryCount,
                        stepId: request.stepId,
                      });
                    },
                  },
                ),
            });
            activeLoopRunner = runner;
            const loopResult = await runner.run();
            outputs = loopResult.outputs;
            transcript = loopResult.transcript;
            loopSnapshot = loopResult.snapshot;
            if (loopResult.error !== undefined) throw loopResult.error;
            return { outputs, transcript };
          }
          if (workflow && workflow.length > 0) {
            const orchestrator = new Orchestrator(workflow, {
              createAgent: (name, stepId) =>
                this.createAgent(
                  name,
                  (event) => emit(stepId ? ({ ...event, stepId } as CoreMindEvent) : event),
                  stepId,
                ),
              events: emit,
              initialPrompt: effectiveInitialPrompt,
              signal: this.options.signal,
              maxSteps: limits.maxSteps,
              stepTimeoutMs: limits.stepTimeoutMs,
              maxRetries: limits.maxRetries,
              initialRetryCount:
                resumePlan?.previousTrace.filter((entry) => entry.event.type === "retry").length ??
                0,
              completedSteps: resumePlan?.completedSteps,
            });
            const workflowOutputs = await orchestrator.run();
            return { outputs: workflowOutputs, transcript: lastOutputText(workflowOutputs) };
          }
          // 单 agent 模式
          const name = this.config.defaultAgent ?? firstKey(this.config.agents);
          if (!name) {
            throw new CoreMindError(
              "no_agent",
              "配置中没有定义任何 agent，请至少定义一个 agents 条目",
            );
          }
          if (effectiveInitialPrompt === undefined) {
            throw new CoreMindError(
              "no_prompt",
              "未提供输入：单 agent 模式需要 --prompt 参数，或配置 workflow 步骤",
            );
          }
          const agent = this.createAgent(name, emit);
          if (!agent) {
            throw new CoreMindError("unknown_agent", `默认 agent ${name} 不存在`);
          }
          const messageCursor = agent.state.messages.length;
          await agent.prompt(effectiveInitialPrompt);
          await agent.waitForIdle();
          const agentError = extractAgentError(agent.state.messages);
          if (agentError) {
            throw new CoreMindError("agent_failed", `Agent ${name} 执行失败：${agentError}`);
          }
          transcript = extractText(agent.state.messages.slice(messageCursor));
          return { outputs: new Map<string, StepOutput>(), transcript };
        },
        (error) => activeLoopRunner?.interrupt(error),
      ));
      if (capabilityFailure) throw capabilityFailure;
      if (checkpointFailure) throw checkpointFailure;
      budget.throwIfExceeded();
    } catch (error) {
      terminalError = checkpointFailure ?? error;
      try {
        if (!checkpointFailure) budget.throwIfExceeded();
      } catch (budgetError) {
        terminalError = budgetError;
      }
      // step_timeout / budget_exceeded 与 Abort 共用准入机制（规格 03 §1）：
      // 终止确定后设置分界点，拦截其后的迟到终态事实
      const code = terminalError instanceof CoreMindError ? terminalError.code : undefined;
      if (!journal.isAborted() && (code === "step_timeout" || code === "budget_exceeded")) {
        journal.markAborted(knownTurnIdsFrom(collected));
      }
      if (
        code === "aborted" ||
        code === "run_timeout" ||
        code === "step_timeout" ||
        code === "budget_exceeded"
      ) {
        try {
          await toolExecutionEngine.settleInterrupted(
            code === "run_timeout" || code === "step_timeout" ? "timed_out" : "aborted",
            `Run 以 ${code} 终止`,
          );
        } catch (lifecycleError) {
          lifecycleFailure =
            lifecycleError instanceof CoreMindError
              ? lifecycleError
              : new CoreMindError(
                  "tool_lifecycle_invalid",
                  lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError),
                );
        }
      }
    } finally {
      this.activeHarnessFactory = undefined;
    }

    while (lifecycleFinalizers.size > 0) {
      await Promise.allSettled([...lifecycleFinalizers]);
    }
    if (
      lifecycleFailure &&
      (terminalError === undefined ||
        (terminalError instanceof CoreMindError && terminalError.code === "agent_failed"))
    ) {
      terminalError = lifecycleFailure;
    }

    // 静止等待（规格 03 §5）：runWithGuard 收尾路径调用，等所有 agent 真正 idle、
    // pending 工具结束、journal 落盘队列清空；超时记录 quiescence_timeout 事件不改变终态
    await this.waitForQuiescence(DEFAULT_QUIESCENCE_TIMEOUT_MS);

    let sessionFile: string | undefined;
    // D-4 方案 A：abort 后也写会话树（只写已确认部分，竞态赢家文本丢弃）；
    // 审批拒绝等 paused（loop_paused）是可在用户处置后继续的暂停态，同样应落盘已确认部分，
    // 使持久事实可重建该 Run 的请求（规格 01 §2 请求重建契约的适用范围）
    const terminalCode = terminalError instanceof CoreMindError ? terminalError.code : undefined;
    sessionPersistPaused = terminalCode === "loop_paused";
    if (terminalError === undefined || journal.isAborted() || sessionPersistPaused) {
      try {
        sessionFile = await this.persistSession();
      } catch (error) {
        terminalError = error;
      }
    }
    const allMessages = [...this.collectMessages().values()].flat();
    // transcript 回退（方案 A）：仅 abort 未生效且存在终态错误时允许回捞；
    // abort 生效后以已确认事实为准，不回捞竞态赢家文本（规格 03 §3）
    if (terminalError !== undefined && transcript.length === 0 && !journal.isAborted()) {
      transcript = extractText(allMessages);
    }
    try {
      await journal.flush("critical");
    } catch (error) {
      terminalError = durabilityFailure(error);
    }
    const metrics = analyzeRunMetrics(
      collected,
      allMessages,
      performance.now() - started,
      transcript.length,
      journal.rejectedAfterAbort(),
    );
    let outcome = new RunTerminalizer().terminalize(collected, terminalError);
    // 输入收据终态（规格 03 §4）：succeeded → completed；abort/超时/预算/失败 → discarded
    // （未消费输入）；paused（审批拒绝等）保持 claimed，resume 继续同一输入
    if (inputReceiptState !== undefined && inputReceiptState !== "completed") {
      if (outcome.status === "succeeded") {
        inputReceiptState = "completed";
        emitInputEvent(completeInput({ inputId: inputId! }));
      } else if (outcome.status !== "paused") {
        inputReceiptState = "discarded";
        emitInputEvent(discardInput({ inputId: inputId! }));
      }
    }
    let evaluation = createEvaluationReport(this.config.quality, metrics);
    let releaseReadiness = assessReleaseReadiness(outcome, evaluation);
    const irreversibleTools = [
      ...new Set(
        checkpointManager.records
          .filter((checkpoint) => !checkpoint.reversible)
          .map((checkpoint) => checkpoint.tool),
      ),
    ];
    if (irreversibleTools.length > 0) {
      releaseReadiness.warnings.push(
        `存在不可自动回退的工具执行：${irreversibleTools.join("、")}；请结合 Trace 和外部系统记录复核`,
      );
    }
    if (outcome.status === "paused") {
      persistOperation({
        eventId: randomUUID(),
        type: "PAUSE",
        reason: outcome.finishReason,
      });
    } else {
      if (outcome.status === "aborted") {
        persistOperation({
          eventId: randomUUID(),
          type: "REQUEST_ABORT",
          reason: outcome.finishReason,
        });
        persistOperation({
          eventId: randomUUID(),
          type: "FAIL",
          reason: outcome.finishReason,
        });
      } else if (outcome.status === "succeeded") {
        persistOperation({ eventId: randomUUID(), type: "COMPLETE" });
      } else {
        persistOperation({
          eventId: randomUUID(),
          type: "FAIL",
          reason: outcome.finishReason,
        });
      }
    }
    await dispatchLifecycle("run-finished", {
      runId,
      operation: operation.snapshot(),
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      checkpointCount: checkpointManager.records.length,
      artifactCount: artifacts.length,
    });
    if (outcome.status === "paused") {
      journal.pause({
        operation: operation.snapshot(),
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        ...(loopSnapshot ? { loopSnapshot } : {}),
      });
    } else {
      journal.finish({
        operation: operation.snapshot(),
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
      });
    }
    const terminalDurabilityFailure =
      terminalError instanceof CoreMindError &&
      (terminalError.code === "durability_unsupported" ||
        terminalError.code === "durability_barrier_failed");
    try {
      await journal.flush(terminalDurabilityFailure ? "ordinary" : "critical");
    } catch (error) {
      const finalDurabilityFailure = durabilityFailure(error);
      terminalError = finalDurabilityFailure;
      // 首条 finish 已入 append-only 日志后，只允许紧邻的收敛 finish；错误仍通知调用方，
      // 但不再追加会违反 I-3 的终态后 Trace Fact。
      userEvents({ type: "error", message: finalDurabilityFailure.message, fatal: true });
      outcome = new RunTerminalizer().terminalize(collected, terminalError);
      evaluation = createEvaluationReport(this.config.quality, metrics);
      releaseReadiness = assessReleaseReadiness(outcome, evaluation);
      // append-only 日志不能删除先前未获 critical ack 的候选终态；追加最终失败收敛记录，
      // 让持久投影与返回结果都以最后一条 finish 为准。
      journal.finish({
        operation: operation.snapshot(),
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        supersedesUnacknowledgedTerminal: true,
      });
      await journal.flush("ordinary");
    }
    const snapshot = createRunSnapshot({
      runId: trace.runId,
      operation: operation.snapshot(),
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      trace: trace.entries,
      checkpoints: checkpointManager.records,
      artifacts,
      extensions: extensionReceipts,
    });
    return {
      runId: trace.runId,
      operation: operation.snapshot(),
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      trace: trace.entries,
      runStateFile: runStore.pathFor?.(runId),
      checkpoints: checkpointManager.records,
      outputs,
      messages: this.collectMessages() as unknown as Map<string, CoreMindMessage[]>,
      transcript,
      sessionFile,
      artifacts,
      extensions: extensionReceipts,
      snapshot,
    };
  }

  private async runWithGuard<T>(
    timeoutMs: number,
    journal: RunStateJournal,
    knownTurnIds: () => ReadonlySet<string>,
    operation: () => Promise<T>,
    onGuardError?: (error: CoreMindError) => Promise<void> | undefined,
  ): Promise<T> {
    const signal = this.options.signal;
    if (signal?.aborted) throw new CoreMindError("aborted", "执行已中止");
    let timer: NodeJS.Timeout | undefined;
    let rejectAbort: ((reason: CoreMindError) => void) | undefined;
    let guardTriggered = false;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const triggerGuard = (error: CoreMindError, reject: (reason: CoreMindError) => void): void => {
      if (guardTriggered) return;
      guardTriggered = true;
      // Abort 生效点（规格 03 §1）：设置事件准入分界点，此后迟到终态事实不再写入；
      // 分界前已启动的活动集合用于 R3 判定（分界前启动的工具 receipt 放行）。
      // interrupt 先触发（loop 内部取消），随后同步 abortAll 尽早终止在飞活动，
      // 让静止判定尽快满足（Cancel → Quiescent）
      journal.markAborted(knownTurnIds());
      void Promise.resolve(onGuardError?.(error)).catch(() => undefined);
      this.abortAll();
      void Promise.resolve().then(() => reject(error));
    };
    const onAbort = () => {
      if (rejectAbort) triggerGuard(new CoreMindError("aborted", "执行已中止"), rejectAbort);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timedOut =
      timeoutMs > 0
        ? new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              triggerGuard(
                new CoreMindError("run_timeout", `运行超时（${timeoutMs}ms），已中止`),
                reject,
              );
            }, timeoutMs);
          })
        : new Promise<never>(() => {});
    try {
      return await Promise.race([operation(), aborted, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async executeLoopStep(
    request: LoopStepRequest,
    emit: (event: CoreMindEvent) => void,
    timeoutMs: number,
    collected: CoreMindEvent[],
  ): Promise<string> {
    const eventCursor = collected.length;
    const agent = this.createAgent(
      request.agent,
      (event) => emit({ ...event, stepId: request.stepId } as CoreMindEvent),
      request.stepId,
    );
    if (!agent) {
      throw new CoreMindError(
        "unknown_agent",
        `Loop 引用了未定义的 agent：${request.agent}（${request.stepId}）`,
      );
    }
    const messageCursor = agent.state.messages.length;
    let timer: NodeJS.Timeout | undefined;
    const operation = (async () => {
      await agent.prompt(request.input);
      await agent.waitForIdle();
    })();
    try {
      if (timeoutMs > 0) {
        await Promise.race([
          operation,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              agent.abort();
              reject(
                new CoreMindError(
                  "step_timeout",
                  `步骤 ${request.stepId} 执行超时（${timeoutMs}ms），已中止`,
                ),
              );
            }, timeoutMs);
          }),
        ]);
      } else {
        await operation;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const stepEvents = collected.slice(eventCursor);
    const budgetExceeded = stepEvents.find((event) => event.type === "budget_exceeded");
    if (budgetExceeded?.type === "budget_exceeded") {
      throw new CoreMindError("budget_exceeded", budgetExceeded.message);
    }
    if (stepEvents.some((event) => event.type === "policy_denied")) {
      throw new CoreMindError("loop_paused", `步骤 ${request.stepId} 的工具请求未获批准`);
    }
    const lastAssistant = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      throw new CoreMindError("aborted", `步骤 ${request.stepId} 已中止`);
    }
    if (lastAssistant?.stopReason === "error") {
      const agentError = lastAssistant.errorMessage ?? "模型执行失败，但未提供错误详情";
      const code = classifyRetry(lastAssistant).retryable ? "provider_transient" : "agent_failed";
      throw new CoreMindError(code, `步骤 ${request.stepId} 的 Agent 执行失败：${agentError}`);
    }
    return extractText(agent.state.messages.slice(messageCursor));
  }

  private abortAll(): void {
    for (const agent of this.lastAgents.values()) agent.abort();
  }

  private collectMessages(): Map<string, AgentMessage[]> {
    const messages = new Map<string, AgentMessage[]>();
    for (const [name, agent] of this.lastAgents) messages.set(name, agent.state.messages);
    return messages;
  }

  /**
   * 等待静止（规格 03 §5）：所有 agent 已 idle ∧ 无 pending 工具结果 ∧
   * journal 无 pending flush（append 队列空且已落盘）。
   * 超时上限与 runTimeout 解耦（独立 quiescenceTimeout，默认 5s）：
   * 超时记录 quiescence_timeout 事件但不改变终态。返回是否达到静止。
   */
  async waitForQuiescence(timeoutMs: number = DEFAULT_QUIESCENCE_TIMEOUT_MS): Promise<boolean> {
    const journal = this.runJournal;
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (isQuiescent(this.lastAgents, journal)) return true;
      if (performance.now() >= deadline) {
        this.options.events?.({ type: "quiescence_timeout", timeoutMs });
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, QUIESCENCE_POLL_INTERVAL_MS));
    }
  }

  /** 会话配置开启时，把主 agent 本轮新增消息追加落盘（返回会话文件路径） */
  async persistSession(): Promise<string | undefined> {
    const sessionId = this.options.sessionId;
    const session = this.config.session;
    if (!sessionId || !session?.enabled) return undefined;
    const main = this.lastAgents.get(this.mainAgentName);
    if (!main) return undefined;
    const cm =
      this.activeSession ??
      (await CoreMindSession.open({
        dir: sessionDir(this.config, this.options.configDir),
        sessionId,
        cwd: this.options.cwd ?? process.cwd(),
      }));
    // 只追加本轮新增：恢复历史已落盘；请求级压缩的摘要与保留区已由压缩条目代表
    let messages = main.state.messages.slice(this.compactedPrefixEnd ?? this.resumedContextLength);
    if (this.runJournal?.isAborted()) {
      // D-4 方案 A：abort 后只写已确认部分——去掉尾部未正常终止的 assistant 消息（竞态赢家文本）
      messages = trimUnconfirmedTail(messages);
    } else if (sessionPersistPaused) {
      // 审批拒绝等 paused：只落已发送部分——去掉尾部未发送的工具调用产物（toolResult + toolUse）
      messages = trimRejectedTrail(messages);
    }
    await cm.appendMessages(messages);
    // P2b：配置 session.compact 时，上下文超预算自动压缩（LLM 摘要，消耗 token）
    if (session.compact) {
      await cm.maybeCompact(
        this.providerRuntime.models,
        this.providerRuntime.model,
        this.providerRuntime.model.contextWindow,
      );
    }
    return cm.filePath;
  }
}

/** 便捷入口：加载配置 → 构建运行时 */
export async function buildAgentFromConfig(
  options: CoreMindRuntimeOptions,
): Promise<CoreMindRuntime> {
  return CoreMindRuntime.create(options);
}

/** 静止等待默认超时（规格 03 §5：默认 5s，与 runTimeout 解耦） */
const DEFAULT_QUIESCENCE_TIMEOUT_MS = 5_000;

/** 静止轮询间隔：兼顾及时性（Cancel → Quiescent p95 < 250ms）与避免忙等 */
const QUIESCENCE_POLL_INTERVAL_MS = 10;

/**
 * 静止判定（规格 03 §5）：quiescent ⇔ 所有 agent 已 idle ∧ 无 pending 工具结果 ∧
 * journal 无 pending flush。模块级函数而非 private 方法：避免进入 untrimmed d.ts
 * （#39 教训：类私有成员也会进 d.ts，冻结基线逐字哈希会失败）。
 */
function durabilityFailure(error: unknown): CoreMindError {
  return error instanceof CoreMindError
    ? error
    : new CoreMindError(
        "durability_barrier_failed",
        error instanceof Error ? error.message : String(error),
      );
}

function isQuiescent(agents: Map<string, Agent>, journal: RunStateJournal | undefined): boolean {
  for (const agent of agents.values()) {
    if (agent.state.isStreaming) return false;
    if (agent.state.pendingToolCalls.size > 0) return false;
    if (agent.hasQueuedMessages()) return false;
  }
  if (journal !== undefined && hasPendingJournalFlush(journal)) return false;
  return true;
}

/**
 * 从既有事件序列提取已登记的输入 ID（resume 时沿用原 run 的收据，
 * 使收据链跨 run 连续——规格 03 §4：输入收据参与恢复合法性判定）。
 */
function resumedInputId(events: readonly CoreMindEvent[]): InputId | undefined {
  for (const event of events) {
    if (event.type === "input_receipt") return event.inputId as InputId;
  }
  return undefined;
}

function toolCallIdentity(
  agent: string,
  stepId: string | undefined,
  callId: string,
): ToolCallIdentity {
  return { agent, callId, ...(stepId ? { stepId } : {}) };
}

/** 分界前已启动的活动集合（R3 判定用）：从已收集事件的 turnId 提取 */
function knownTurnIdsFrom(collected: readonly CoreMindEvent[]): Set<string> {
  return new Set(
    collected.flatMap((event) => {
      const turnId = (event as { turnId?: string }).turnId;
      return turnId ? [turnId] : [];
    }),
  );
}

/**
 * 当前 Run 是否因审批拒绝等 paused（persistSession 落已发送部分用）。
 * 模块级而非类字段：避免进入 api-extractor 的 untrimmed d.ts（冻结基线逐字哈希）。
 * run 由 R7 保证实例内串行，跨实例并发仅在此瞬时标志上偶发串扰，语义安全（多 trim 尾部）。
 */
let sessionPersistPaused = false;

/** D-4 方案 A：去掉尾部未正常终止的 assistant 消息（abort 竞态赢家文本不落会话树） */
function trimUnconfirmedTail(messages: readonly AgentMessage[]): AgentMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1]!;
    if (last.role === "assistant" && last.stopReason !== "stop") end -= 1;
    else break;
  }
  return messages.slice(0, end);
}

/** 审批拒绝等 paused：去掉尾部未发送的工具调用产物（toolResult 及配对的 assistant toolUse） */
function trimRejectedTrail(messages: readonly AgentMessage[]): AgentMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1];
    if (last?.role === "toolResult") {
      end -= 1;
      continue;
    }
    if (last?.role === "assistant" && last.stopReason === "toolUse") {
      end -= 1;
      continue;
    }
    break;
  }
  return messages.slice(0, end);
}

function sessionDir(config: CoreMindConfig, configDir: string): string {
  const configured = config.session?.dir;
  return configured ? path.resolve(configDir, configured) : path.join(configDir, "sessions");
}

function lastOutputText(outputs: Map<string, StepOutput>): string {
  const values = [...outputs.values()];
  const last = values[values.length - 1];
  return last ? last.text : "";
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record)[0];
}
