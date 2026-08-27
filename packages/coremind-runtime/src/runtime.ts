import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentConfig, CoreMindConfig, ToolEffectDeclaration } from "coremind-config";
import { loadDirectorySkills, resolveSkills, SKILLS } from "coremind-templates";
import {
  type ArtifactRecord,
  ArtifactStore,
  extractArtifactRecord,
  inferLegacyToolCapability,
  type ResolvedToolCapability,
  recoveryDispositionFor,
  resolveToolCapability,
  wrapToolWithArtifactCapture,
} from "coremind-tools";
import {
  buildToolsWithExecutionEnvironment,
  createPlatformExecutionEnvironment,
  type ExecutionEnvironment,
  resolveExecutionEnvironment,
} from "coremind-tools/internal";
import type {
  AgentDriver,
  AgentDriverAfterToolCallContext,
  AgentDriverBeforeToolCallContext,
  AgentDriverContextContract,
  AgentDriverHarness,
} from "./agent-driver.js";
import { buildAgentDriver } from "./agent-factory.js";
import { type ResolvedRuntimeLimits, RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import {
  type CheckpointDiff,
  CheckpointManager,
  type CheckpointRecord,
  inspectCheckpoint as inspectStoredCheckpoint,
  restoreCheckpoint as restoreStoredCheckpoint,
} from "./checkpoint.js";
import {
  ChildRunCoordinator,
  type ChildRunCoordinatorOptions,
  type ChildRunDelegationRequest,
  type ChildRunExecutionInput,
  type ChildRunHandle,
  type ChildRunPolicySnapshot,
} from "./child-run.js";
import {
  type CoreMindChildRunAdapter,
  isCoreMindChildRunAdapter,
} from "./child-runtime-adapter.js";
import {
  assessRuntimeEngineeringEvidence,
  createToolExecutionEvidence,
} from "./coding/runtime-engineering-evidence.js";
import {
  type BranchMessage,
  projectBranchMessages,
  projectContextCompactionLedger,
  projectRawBranchMessages,
} from "./compaction-projection.js";
import {
  type ContextCompactionLedgerEntry,
  ContextLifecycleError,
  ContextLifecycleManager,
  type ContextLifecyclePreparation,
} from "./context-lifecycle.js";
import { type ContextPlanStep, projectContextTaskState } from "./context-task-state.js";
import {
  type ControlApplyResult,
  ControlInbox,
  type ControlReceipt,
  type InternalRunControlCommand,
  type RunControlCommand,
} from "./control-inbox.js";
import {
  createEffectReceiptBinding,
  type EffectReceiptBinding,
  fingerprintEffectReceiptValue,
} from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractAgentError, extractText } from "./events.js";
import { enforceExecutionSecurity } from "./execution-security.js";
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
  createTelemetryConfigurationFact,
  type LocalObservabilityProjection,
  projectLocalObservability,
  type TelemetryConsentFact,
  TelemetryEgressController,
  type TelemetryEgressControllerOptions,
  type TelemetryPolicy,
  validateTelemetryConsentBinding,
  validateTelemetryConsentFact,
} from "./observability.js";
import {
  DurableOperation,
  type DurableOperationSnapshot,
  type OperationEvent,
  restoreDurableOperation,
} from "./operation-state.js";
import { Orchestrator, type StepOutput } from "./orchestrator.js";
import { type ChildRunTreeProjection, ProjectionEngine } from "./projection.js";
import { buildProviderRuntime, type ProviderRuntime } from "./provider.js";
import type { CoreMindMessage } from "./public-message.js";
import { adaptCoreMindTool, type CoreMindToolDefinition } from "./public-tool.js";
import { createProviderRequestReplayFact } from "./replay-kit.js";
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
import { RunContext } from "./run-context.js";
import { RunEffectCoordinator } from "./run-effect-coordinator.js";
import { RunKernel } from "./run-kernel.js";
import {
  FileRunStore,
  fingerprintRunConfig,
  RunStateJournal,
  type RunStore,
  type RunStoreDurability,
} from "./run-state.js";
import { RunTerminalizer } from "./run-terminalizer.js";
import { registerCoreMindRuntimeInstance } from "./runtime-instance-authority.js";
import { CoreMindSession } from "./session.js";
import { createRunSnapshot, type RunSnapshot } from "./snapshot.js";
import { type ToolCallIdentity, ToolExecutionEngine } from "./tool-call-lifecycle.js";
import { toolCapabilityCallKey } from "./tool-capability-identity.js";
import { type ApprovalDecision, type ToolApprovalRequest, ToolPolicy } from "./tool-policy.js";
import { type CoreMindTraceEvent, TraceRecorder } from "./trace.js";
import { TurnTracker } from "./turn-tracker.js";
import {
  canonicalizeWorkspace,
  type WorkspaceLeaseHandle,
  WorkspaceLeaseService,
} from "./workspace-lease.js";

type RuntimeHarness = AgentDriverHarness;

type AgentDriverBuilder = (input: {
  onEvent: (event: CoreMindEvent) => void;
  harness?: RuntimeHarness;
  sessionMessages?: CoreMindMessage[];
}) => AgentDriver;

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
  /** 可选 Child Run 深模块；父身份、Journal 与 RunStore 始终由当前 Runtime 注入。 */
  childRuns?: Omit<
    ChildRunCoordinatorOptions,
    "parentRunId" | "parentJournal" | "runStore" | "reserveParentBudget" | "adapter"
  > & { adapter: CoreMindChildRunAdapter };
  /** 仅供真实 Child Runtime Adapter 绑定并自检本次委派；必须保留同一不可替换输入对象。 */
  childRunAuthority?: ChildRunExecutionInput;
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

export interface ProtocolStartIdentity {
  protocolVersion: "2.0";
  method: "run" | "chat" | "resume";
  fingerprint: string;
  acceptedAt: string;
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
  /** 默认开启、从 Facts 派生的本地观测；外传交付状态不参与恢复。 */
  observability: LocalObservabilityProjection;
  /** 从 canonical Facts 重建的完整 Child Run tree；没有委派时省略。 */
  childRuns?: ChildRunTreeProjection;
}

/**
 * CoreMind 运行时门面：配置 → provider/工具/agent → 执行。
 * 库形式嵌入入口：buildAgentFromConfig / CoreMindRuntime.create().run()
 */
export class CoreMindRuntime {
  /** 最近创建的每个 agent 实例（收集最终消息/落盘用） */
  private readonly lastAgents = new Map<string, AgentDriver>();
  /** 恢复的会话上下文消息数（0 = 未恢复） */
  readonly resumedContextLength: number;
  /** 主 agent 名（会话归属） */
  private readonly mainAgentName: string;
  /** 恢复视图（作为主 agent 初始消息） */
  private readonly sessionMessages?: CoreMindMessage[];
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
    private readonly driverBuilders: Map<string, AgentDriverBuilder>,
    private readonly toolEffectsByAgent: Map<string, Map<string, ToolEffectDeclaration>>,
    private readonly toolCapabilitiesByAgent: Map<string, Map<string, ResolvedToolCapability>>,
    private readonly providerRuntime: ProviderRuntime,
    private readonly executionEnvironment: ExecutionEnvironment,
    private readonly options: CoreMindRuntimeOptions,
    sessionMessages: CoreMindMessage[] | undefined,
    resumedContextLength: number,
    skillsByAgent: Map<string, string[]>,
  ) {
    registerCoreMindRuntimeInstance(this);
    this.sessionMessages = sessionMessages;
    this.resumedContextLength = resumedContextLength;
    this.mainAgentName = config.defaultAgent ?? firstKey(config.agents) ?? "";
    this.skillsByAgent = skillsByAgent;
    // 这些读取只用于保留已冻结的私有声明布局；执行状态已迁移到 RunContext。
    void this.lastAgents;
    void this.activeHarnessFactory;
    void this.activeRunPromise;
    void this.runJournal;
    void this.activeSession;
  }

  /** 由配置构建运行时（注册 provider、构建工具与全部 agent 定义） */
  static async create(options: CoreMindRuntimeOptions): Promise<CoreMindRuntime> {
    const { config, configDir } = options;
    const cwd = options.cwd ?? process.cwd();
    const env = options.env ?? process.env;
    enforceExecutionSecurity(
      config,
      (name) => typeof env[name] === "string" && env[name]!.length > 0,
    );
    const emit = options.events ?? (() => {});

    // 1. provider（解析模型，警告转发）
    const providerRuntime = await buildProviderRuntime(config.provider, env);
    for (const warning of providerRuntime.warnings) {
      emit({ type: "error", message: warning, fatal: false });
    }

    // 2. 每个 agent：构建工具与技能（Agent 实例按需创建，避免并发冲突）
    const agentConfigs = new Map<string, AgentConfig>();
    const driverBuilders = new Map<string, AgentDriverBuilder>();
    const toolEffectsByAgent = new Map<string, Map<string, ToolEffectDeclaration>>();
    const toolCapabilitiesByAgent = new Map<string, Map<string, ResolvedToolCapability>>();
    const skillsByAgent = new Map<string, string[]>();
    const artifactStore = new ArtifactStore({ cwd });
    const executionEnvironment = createPlatformExecutionEnvironment({
      workspaceRoot: cwd,
      env,
    });
    const externalTools = (options.toolDefinitions ?? []).map((definition) =>
      wrapToolWithArtifactCapture(adaptCoreMindTool(definition), artifactStore),
    );
    // 自定义技能（生态机制）：配置文件所在目录的 skills/ 下，每个子目录的 README.md 即一个技能
    const customSkills = await loadDirectorySkills(path.join(configDir, "skills"));
    for (const [name, agentCfg] of Object.entries(config.agents)) {
      const toolConfigs = (agentCfg.tools?.length ?? 0) > 0 ? agentCfg.tools : config.tools;
      const { tools, warnings, effects, capabilities } = await buildToolsWithExecutionEnvironment(
        toolConfigs ?? [],
        {
          cwd,
          configDir,
          env,
          artifactStore,
        },
        executionEnvironment,
      );
      for (const warning of warnings) {
        emit({ type: "error", message: warning, fatal: false });
      }
      agentConfigs.set(name, agentCfg);
      const driverTools = [...tools, ...externalTools];
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
      driverBuilders.set(name, ({ onEvent, harness, sessionMessages }) =>
        buildAgentDriver(agentCfg, {
          models: providerRuntime.models,
          model: providerRuntime.model,
          tools: driverTools,
          agentName: name,
          onEvent,
          apiKeyOverride: providerRuntime.apiKeyOverride,
          sessionMessages,
          skillsContent: allContents,
          stableFacts: {
            provider: providerRuntime.model.provider,
            model: providerRuntime.model.id,
            contextWindow: providerRuntime.model.contextWindow,
          },
          promptCacheStatus: providerRuntime.promptCacheStatus,
          harness,
        }),
      );
    }

    // 会话恢复：--session 且 session.enabled 时，打开已有会话注入历史视图（非破坏）
    let sessionMessages: CoreMindMessage[] | undefined;
    let resumedContextLength = 0;
    if (options.sessionId && config.session?.enabled) {
      const dir = sessionDir(config, configDir);
      try {
        if (await CoreMindSession.exists(dir, options.sessionId, cwd)) {
          const cm = await CoreMindSession.open({ dir, sessionId: options.sessionId, cwd });
          const restored = projectBranchMessages(await cm.branchEntries()).map(
            (item) => item.message,
          );
          if (restored.length > 0) {
            sessionMessages = restored as unknown as CoreMindMessage[];
            resumedContextLength = restored.length;
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
      driverBuilders,
      toolEffectsByAgent,
      toolCapabilitiesByAgent,
      providerRuntime,
      executionEnvironment,
      options,
      sessionMessages,
      resumedContextLength,
      skillsByAgent,
    );
  }

  /** 按名字创建独立 Driver 实例（每次新实例，消息历史独立） */
  private createAgent(
    name: string,
    onEvent: (event: CoreMindEvent) => void = this.options.events ?? (() => {}),
    stepId?: string,
  ): AgentDriver | undefined {
    const buildDriver = this.driverBuilders.get(name);
    if (!buildDriver) return undefined;
    const context = runContextFor(this);
    const harness = context.harnessFor(name, stepId);
    const agent = buildDriver({
      onEvent,
      // 恢复视图只注入主 agent（会话归属者）
      sessionMessages: name === this.mainAgentName ? this.sessionMessages : undefined,
      harness,
    });
    context.registerAgent(name, agent);
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
      this.driverBuilders,
      this.toolEffectsByAgent,
      this.toolCapabilitiesByAgent,
      this.providerRuntime,
      this.executionEnvironment,
      {
        ...this.options,
        config: turnConfig,
        initialPrompt: message,
        events,
        signal,
      },
      history,
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
    const slot = executionSlotFor(this);
    slot.kernel ??= new RunKernel({ execute: (context) => this.executeRunBody(context) });
    return slot.kernel.run();
  }

  /** 在活动父 Run 上创建类型化 Child Run；未配置或尚未启动时失败关闭。 */
  async delegateChildRun(request: ChildRunDelegationRequest): Promise<ChildRunHandle> {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      const childRuns = executionSlotFor(this).kernel?.currentContext()?.currentChildRuns();
      if (childRuns) return childRuns.delegate(request);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new CoreMindError(
      "child_run_unavailable",
      "当前 Runtime 未启用 Child Run 或尚未进入活动状态",
    );
  }

  /** Adapter 执行前验证工厂没有丢失或放宽 Child Run 身份、取消与策略。 */
  async verifyChildRunAuthority(input: ChildRunExecutionInput): Promise<void> {
    if (
      this.options.childRunAuthority !== input ||
      this.options.runId !== input.childRunId ||
      this.options.signal !== input.signal ||
      this.options.initialPrompt !== input.request.task
    ) {
      throw new CoreMindError(
        "child_run_identity_mismatch",
        "Child Runtime 未绑定原始委派输入、RunId、AbortSignal 或任务输入",
      );
    }
    await assertRuntimeChildPolicyAuthority({
      policy: input.inheritedPolicy,
      config: this.config,
      provider: this.providerRuntime,
      executionEnvironment: this.executionEnvironment,
      workspaceRoot: this.options.cwd ?? process.cwd(),
      tools: new Set(
        [...this.toolCapabilitiesByAgent.values()].flatMap((capabilities) => [
          ...capabilities.keys(),
        ]),
      ),
      limits: resolveRuntimeLimits(this.config.runtime, {
        maxSteps: this.options.maxSteps,
        stepTimeoutMs: this.options.stepTimeoutMs,
      }),
    });
  }

  /** 接收已类型化控制；ACK 只由当前 Run 的持久 ControlInbox 产生。 */
  async acceptControl(command: RunControlCommand): Promise<ControlReceipt> {
    for (let attempt = 0; attempt < 5_000; attempt++) {
      const inbox = this.currentControlInbox();
      if (inbox) return inbox.accept(command);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new CoreMindError(
      "control_unavailable",
      `等待 Runtime ${command.runId} 的 ControlInbox 超时`,
    );
  }

  /** 当新的可应用点出现时，重试仍处于 accepted 的持久控制。 */
  async applyPendingControls(): Promise<ControlReceipt[]> {
    const inbox = this.currentControlInbox();
    return inbox?.applyPending() ?? [];
  }

  private currentControlInbox(): ControlInbox | undefined {
    return executionSlotFor(this).kernel?.currentContext()?.currentControlInbox();
  }

  /** run() 主体（并发检测由外层 run() 包装） */
  private async executeRunBody(context: RunContext<RuntimeHarness>): Promise<RunResult> {
    context.attachExecutionEnvironment(this.executionEnvironment);
    const started = performance.now();
    const lifecycleHost = this.options.lifecycleExtensions
      ? new LifecycleExtensionHost(this.options.lifecycleExtensions)
      : undefined;
    const runStore =
      this.options.runStore ??
      new FileRunStore(path.join(this.options.configDir, ".coremind", "runs"));
    const configFingerprint = fingerprintRunConfig(this.config);
    const telemetryPolicy = telemetryPolicyFromConfig(this.config);
    const telemetryConfiguration = createTelemetryConfigurationFact(
      telemetryPolicy,
      new Date().toISOString(),
    );
    const telemetryConsents = (this.options.telemetry?.consents ?? []).map((consent) =>
      validateTelemetryConsentFact(consent),
    );
    // 会话树关联：打开会话拿 seq 水位与已落盘视图（压缩条目落盘与重建桥接用）
    let sessionSeqStart: number | undefined;
    let canonicalSessionBranch: BranchMessage[] = [];
    let previousContextCompactions: ContextCompactionLedgerEntry[] = [];
    if (this.options.sessionId && this.config.session?.enabled) {
      const session = await CoreMindSession.open({
        dir: sessionDir(this.config, this.options.configDir),
        sessionId: this.options.sessionId,
        cwd: this.options.cwd ?? process.cwd(),
      });
      const sessionEntries = await session.branchEntries();
      sessionSeqStart = sessionEntries.reduce((max, entry) => Math.max(max, entry.seq), 0);
      context.attachSession(session, projectBranchMessages(sessionEntries));
      canonicalSessionBranch = projectRawBranchMessages(sessionEntries);
      previousContextCompactions = projectContextCompactionLedger(sessionEntries);
    }
    const resumeRecords = this.options.resumeRunId
      ? await runStore.read(this.options.resumeRunId)
      : undefined;
    if (resumeRecords && resumeRecords.length > 0 && !this.options.childRuns) {
      const childRuns = ProjectionEngine.project(resumeRecords).childRuns;
      if (childRuns && !childRuns.quiescent) {
        throw new CoreMindError(
          "child_run_orphan_audit_required",
          "恢复记录包含未处置 Child Run，必须配置 Child Run Coordinator 完成 orphan audit",
        );
      }
    }
    const resumePlan = resumeRecords
      ? ProjectionEngine.prepareResume(resumeRecords, configFingerprint, this.options.initialPrompt)
      : undefined;
    for (const candidate of resumePlan?.toolReplayCandidates ?? []) {
      const currentCapability =
        this.toolCapabilitiesByAgent.get(candidate.agent)?.get(candidate.tool) ??
        resolveToolCapability({ tool: candidate.tool });
      if (fingerprintEffectReceiptValue(currentCapability) !== candidate.capabilityFingerprint) {
        throw new CoreMindError(
          "tool_capability_conflict",
          `恢复调用 ${candidate.previousCallId} 的 Tool Capability 已漂移，不能自动重放`,
        );
      }
    }
    // 预生成 runId（D-1）：resume 时以恢复记录为准，否则优先使用调用方预生成值
    const runId: RunId = (resumePlan?.runId ?? this.options.runId ?? randomUUID()) as RunId;
    const effectiveInitialPrompt = resumePlan?.initialPrompt ?? this.options.initialPrompt;
    const journal = new RunStateJournal(runId, runStore, resumePlan?.nextJournalSequence ?? 0);
    context.attachJournal(journal);
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
        ...(this.options.protocolStart ? { protocolStart: this.options.protocolStart } : {}),
        ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
        ...(sessionSeqStart !== undefined
          ? { sessionSeqStart, turnSeqStart: sessionSeqStart }
          : {}),
      });
      await journal.appendFact("telemetry_configuration", telemetryConfiguration, {
        durability: "critical",
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
        telemetry: telemetryConfiguration,
        ...(this.options.protocolStart ? { protocolStart: this.options.protocolStart } : {}),
      });
    }
    for (const consent of telemetryConsents) {
      validateTelemetryConsentBinding(consent, await runStore.read(runId));
      await journal.appendFact("telemetry_consent", consent, { durability: "critical" });
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
    context.attachControlInbox(
      new ControlInbox({
        runId,
        journal,
        records: await runStore.read(runId),
        apply: (command) => this.applyRunControl(command, context),
      }),
    );
    const capabilityByCallId = new Map<
      string,
      { tool: string; capability: ResolvedToolCapability }
    >();
    const trace = new TraceRecorder(
      runId,
      (entry) => {
        void journal.appendFact("event", entry, {
          durability: traceFactDurability(entry.event, capabilityByCallId),
          eventId: entry.eventId,
        });
        this.options.trace?.(entry);
      },
      resumePlan?.previousTrace,
    );
    const collected: CoreMindEvent[] = resumePlan?.previousTrace.map((entry) => entry.event) ?? [];
    const toolReplayCandidates = [...(resumePlan?.toolReplayCandidates ?? [])];
    const userEvents = this.options.events ?? (() => {});
    const turnTracker = new TurnTracker();
    const effectBindingByCall = new Map<
      string,
      {
        args: unknown;
        turnId: string;
        tool: string;
        agent: string;
        callId: string;
        stepId?: string;
      }
    >();
    const effectBindingByReceipt = new Map<string, EffectReceiptBinding>();
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
      let enriched = turnTracker.withTurnId(event);
      if (enriched.type === "tool_call" && enriched.callId && enriched.turnId) {
        effectBindingByCall.set(
          toolCapabilityCallKey(enriched.agent, enriched.stepId, enriched.callId),
          {
            args: enriched.args,
            turnId: enriched.turnId,
            tool: enriched.tool,
            agent: enriched.agent,
            callId: enriched.callId,
            ...(enriched.stepId ? { stepId: enriched.stepId } : {}),
          },
        );
      }
      if (enriched.type === "effect_receipt") {
        if (!enriched.agent || !enriched.callId || !enriched.turnId) {
          throw new CoreMindError(
            "effect_receipt_conflict",
            `EffectReceipt ${enriched.idempotencyKey} 缺少 Agent、Turn 或 Call 身份`,
          );
        }
        const callKey = toolCapabilityCallKey(enriched.agent, enriched.stepId, enriched.callId);
        const call = effectBindingByCall.get(callKey);
        const capability = capabilityByCallId.get(callKey)?.capability;
        if (!call || !capability || call.tool !== enriched.tool) {
          throw new CoreMindError(
            "effect_receipt_conflict",
            `EffectReceipt ${enriched.idempotencyKey} 无法绑定到冻结的 Tool Call 与 Capability`,
          );
        }
        const binding = createEffectReceiptBinding({
          runId,
          turnId: enriched.turnId,
          agent: enriched.agent,
          ...(enriched.stepId ? { stepId: enriched.stepId } : {}),
          callId: enriched.callId,
          tool: enriched.tool,
          args: call.args,
          capability,
        });
        const previous = effectBindingByReceipt.get(enriched.idempotencyKey);
        if (
          previous &&
          fingerprintEffectReceiptValue(previous) !== fingerprintEffectReceiptValue(binding)
        ) {
          throw new CoreMindError(
            "effect_receipt_conflict",
            `EffectReceipt ${enriched.idempotencyKey} 关联了不同的 Run、Turn、Call、参数或 Capability`,
          );
        }
        effectBindingByReceipt.set(enriched.idempotencyKey, binding);
        enriched = { ...enriched, binding };
      }
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
    const workspaceLeaseService = new WorkspaceLeaseService();
    const workspaceLeaseByCall = new Map<
      string,
      { lease: WorkspaceLeaseHandle; identity: ToolCallIdentity }
    >();
    const releaseWorkspaceLease = async (identity: ToolCallIdentity): Promise<void> => {
      const callKey = toolCapabilityCallKey(identity.agent, identity.stepId, identity.callId);
      const held = workspaceLeaseByCall.get(callKey);
      if (!held) return;
      const { lease } = held;
      await journal.flush("critical");
      const lifecycle = toolExecutionEngine.inspect(identity);
      await lease.release({
        activeTools: lifecycle?.terminal ? 0 : 1,
        activeProcesses: 0,
        pendingCriticalFacts: journal.pendingFactCount(),
      });
      workspaceLeaseByCall.delete(callKey);
      emit({
        type: "workspace_lease",
        status: "released",
        canonicalRoot: lease.canonicalRoot,
        lane: lease.lane,
        owner: {
          runId: lease.owner.runId,
          callId: lease.owner.callId,
          pid: lease.owner.pid,
        },
        agent: identity.agent,
        callId: identity.callId,
        ...(identity.stepId ? { stepId: identity.stepId } : {}),
      });
      await journal.flush("critical");
    };
    const rollbackWorkspaceLease = async (identity: ToolCallIdentity): Promise<void> => {
      const callKey = toolCapabilityCallKey(identity.agent, identity.stepId, identity.callId);
      const held = workspaceLeaseByCall.get(callKey);
      if (!held) return;
      await held.lease.rollbackBeforeExecution();
      workspaceLeaseByCall.delete(callKey);
      emit({
        type: "workspace_lease",
        status: "released",
        canonicalRoot: held.lease.canonicalRoot,
        lane: held.lease.lane,
        owner: {
          runId: held.lease.owner.runId,
          callId: held.lease.owner.callId,
          pid: held.lease.owner.pid,
        },
        agent: identity.agent,
        callId: identity.callId,
        ...(identity.stepId ? { stepId: identity.stepId } : {}),
      });
      await journal.flush("critical");
    };
    onToolResultRecorded = (event) => {
      const recorded = toolExecutionEngine.inspect({
        ...toolCallIdentity(event.agent, event.stepId, event.callId!),
      });
      if (!recorded || recorded.tool !== event.tool) return;
      queueMicrotask(() => {
        const identity = toolCallIdentity(event.agent, event.stepId, event.callId!);
        const finalizer = (async () => {
          try {
            await journal.flush();
            await toolExecutionEngine.finalizeResult(identity);
            await releaseWorkspaceLease(identity);
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
        context.recordExtension(receipt);
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
    if (this.options.childRuns) {
      if (!isCoreMindChildRunAdapter(this.options.childRuns.adapter)) {
        throw new CoreMindError(
          "child_run_identity_mismatch",
          "CoreMindRuntime 只接受由 createCoreMindChildRunAdapter 创建的受信 Adapter",
        );
      }
      await assertRuntimeChildPolicyAuthority({
        policy: this.options.childRuns.parentPolicy,
        config: this.config,
        provider: this.providerRuntime,
        executionEnvironment: this.executionEnvironment,
        workspaceRoot: this.options.cwd ?? process.cwd(),
        tools: new Set(
          [...this.toolCapabilitiesByAgent.values()].flatMap((capabilities) => [
            ...capabilities.keys(),
          ]),
        ),
        limits,
      });
      context.attachChildRuns(
        await ChildRunCoordinator.open({
          ...this.options.childRuns,
          parentRunId: runId,
          parentJournal: journal,
          runStore,
          reserveParentBudget: (allocation) =>
            budget.reserveChild(allocation, performance.now() - started),
        }),
      );
    }
    const checkpointManager = new CheckpointManager({
      cwd: this.options.cwd ?? process.cwd(),
      rootDir: path.join(this.options.configDir, ".coremind", "checkpoints"),
      runId: trace.runId,
    });
    let checkpointFailure: CoreMindError | undefined;
    let capabilityFailure: CoreMindError | undefined;
    const checkpointByCallId = new Map<string, string[]>();
    const contextLifecycleManager = new ContextLifecycleManager();
    const contextContracts = new Map<string, AgentDriverContextContract>();
    let contextFailure: ContextLifecycleError | undefined;
    const recordContextFailure = (
      failure: ContextLifecycleError,
      preservedMessages: number,
    ): void => {
      contextFailure = failure;
      emit({
        type: "context_lifecycle_failed",
        code: failure.code,
        reason: failure.reason,
        pausable: failure.pausable,
        preservedMessages,
        providerCallBlocked: true,
      });
    };
    const throwIfContextFailed = (): void => {
      if (contextFailure) throw new CoreMindError(contextFailure.code, contextFailure.message);
    };
    const persistContextCompaction = async (
      preparation: ContextLifecyclePreparation,
      sourceMessages: CoreMindMessage[],
      originalMessageCount: number,
    ): Promise<string | undefined> => {
      const compaction = preparation.compaction;
      if (!compaction) return undefined;
      const activeSession = context.sessionHandle();
      if (!activeSession) {
        throw new ContextLifecycleError(
          "Context 压缩需要可持久化 Session；摘要不能只存在于内存",
          "budget_exhausted",
          "context_budget_exhausted",
        );
      }

      let branch = compaction.ledgerEntry.rebuiltFromCanonical
        ? canonicalSessionBranch
        : (context.sessionBranch() ?? []);
      if (branch.length < sourceMessages.length) {
        await activeSession.appendMessages(sourceMessages.slice(branch.length));
        const appendedEntries = await activeSession.branchEntries();
        canonicalSessionBranch = projectRawBranchMessages(appendedEntries);
        context.replaceSessionBranch(projectBranchMessages(appendedEntries));
        branch = compaction.ledgerEntry.rebuiltFromCanonical
          ? canonicalSessionBranch
          : (context.sessionBranch() ?? []);
      }
      const range = compaction.replacedRange;
      if (range.end > branch.length || !branch[range.start] || !branch[range.end - 1]) {
        throw new ContextLifecycleError(
          "Context 压缩范围无法绑定到 canonical Session Facts",
          "lineage_corrupt",
          "context_lineage_corrupt",
        );
      }
      const summaryMessage = preparation.workingSet.messages[0] as {
        content: string;
        timestamp: number;
      };
      const entry = await activeSession.appendCompaction({
        summary: summaryMessage.content,
        retainedTail: preparation.workingSet.messages.slice(1),
        tokensBefore: compaction.tokensBefore,
        details: {
          fingerprint: compaction.summaryFingerprint,
          rangeStartId: branch[range.start]!.entryId,
          rangeEndId: branch[range.end - 1]!.entryId,
          summaryTimestamp: summaryMessage.timestamp,
          contextLifecycle: compaction.ledgerEntry,
        },
      });
      previousContextCompactions.push(compaction.ledgerEntry);
      const updatedEntries = await activeSession.branchEntries();
      canonicalSessionBranch = projectRawBranchMessages(updatedEntries);
      context.replaceSessionBranch(projectBranchMessages(updatedEntries));
      context.setCompactedPrefixEnd(originalMessageCount);
      return entry.id;
    };
    const policy = new ToolPolicy({
      permissions: this.config.permissions,
      allowedPaths: this.options.childRunAuthority?.inheritedPolicy.permissions.paths,
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
    context.setHarnessFactory((agentName, stepId) => {
      let contextWorkingSet: { sourceLength: number; messages: CoreMindMessage[] } | undefined;
      let providerRequestOrdinal = 0;
      let pendingProviderCapabilityFingerprint: string | undefined;
      return {
        maxRetries: loop ? 0 : limits.maxRetries,
        registerContextContract: (contract) => contextContracts.set(agentName, contract),
        beforeModelRequest: throwIfContextFailed,
        onModelRequestDispatched: ({ providerId, modelId, messages }) => {
          const contract = contextContracts.get(agentName);
          if (!contract || !pendingProviderCapabilityFingerprint) {
            throw new ContextLifecycleError(
              "Provider 请求缺少已解析的 Context Working Set",
              "budget_exhausted",
              "context_budget_exhausted",
            );
          }
          providerRequestOrdinal += 1;
          emit({
            type: "provider_request",
            agent: agentName,
            ...(stepId ? { stepId } : {}),
            ...createProviderRequestReplayFact({
              requestId: `${agentName}:${stepId ?? "default"}:${providerRequestOrdinal}`,
              providerId,
              modelId,
              messages,
              stablePrefix: contract.stablePrefix,
              toolSchemas: contract.toolSchemas,
              capabilityFingerprint: pendingProviderCapabilityFingerprint,
            }),
          });
          pendingProviderCapabilityFingerprint = undefined;
        },
        throwIfContextFailed,
        executeTool: ({ call, invoke }) =>
          toolExecutionEngine.executeAdapter(
            toolCallIdentity(agentName, stepId, call.callId),
            invoke,
          ),
        transformContext: async (messages) => {
          if (contextFailure) return messages;
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
          const contract = contextContracts.get(agentName);
          if (!contract) {
            recordContextFailure(
              new ContextLifecycleError(
                `Agent ${agentName} 没有注册可预算的稳定 Context 合同`,
                "invalid_budget",
                "context_capability_conflict",
              ),
              messages.length,
            );
            return messages;
          }
          const remembered = contextWorkingSet;
          const effectiveMessages = remembered
            ? [...remembered.messages, ...messages.slice(remembered.sourceLength)]
            : messages;
          const canonicalMessages = context.sessionHandle()
            ? [
                ...canonicalSessionBranch.map((item) => item.message),
                ...messages.slice(context.compactedPrefixEnd() ?? this.resumedContextLength),
              ]
            : messages;
          const taskState = projectContextTaskState({
            runId,
            agentName,
            initialPrompt: effectiveInitialPrompt,
            projectInstructions: this.agentConfigs.get(agentName)?.systemPrompt,
            permissions: this.config.permissions,
            workflowSteps: this.config.workflow as unknown as ContextPlanStep[] | undefined,
            trace: trace.entries,
          });
          const artifactReferences = context.artifactRecords().flatMap((record) =>
            record.status === "stored" && record.relativePath && record.sha256
              ? [
                  {
                    artifactId: record.artifactId,
                    relativePath: record.relativePath,
                    sizeBytes: record.sizeBytes,
                    sha256: record.sha256,
                  },
                ]
              : [],
          );
          try {
            const preparation = await contextLifecycleManager.prepare({
              providerId: this.providerRuntime.model.provider,
              modelId: this.providerRuntime.model.id,
              resolvedAt: Date.now(),
              capabilityCandidates: this.providerRuntime.contextCapabilityCandidates,
              request: {
                messages: effectiveMessages as unknown as CoreMindMessage[],
                stablePrefix: contract.stablePrefix,
                toolSchemas: contract.toolSchemas,
                ...(this.agentConfigs.get(agentName)?.options?.maxTokens === undefined
                  ? {}
                  : {
                      requestedMaxOutputTokens:
                        this.agentConfigs.get(agentName)!.options!.maxTokens,
                    }),
                taskState,
                workspaceRoot: this.options.cwd ?? process.cwd(),
                artifactReferences,
                canonicalMessages: canonicalMessages as unknown as CoreMindMessage[],
                previousCompactions: previousContextCompactions,
                compactionTrigger: "threshold",
              },
            });
            emit({
              type: "context_budget_resolved",
              providerId: preparation.capability.providerId,
              modelId: preparation.capability.modelId,
              capabilityFingerprint: preparation.capability.configFingerprint,
              source: preparation.capability.source,
              confidence: preparation.capability.confidence,
              effectiveContextWindow: preparation.budget.effectiveContextWindow,
              reservedOutputTokens: preparation.budget.reservedOutputTokens,
              availableInputTokens: preparation.budget.availableInputTokens,
              messageTokens: preparation.budget.messageTokens,
              stablePrefixTokens: preparation.budget.stablePrefixTokens,
              toolSchemaTokens: preparation.budget.toolSchemaTokens,
              structuredOutputTokens: preparation.budget.structuredOutputTokens,
              multimodalTokens: preparation.budget.multimodalTokens,
              protocolOverheadTokens: preparation.budget.protocolOverheadTokens,
              safetyMarginTokens: preparation.budget.safetyMarginTokens,
              estimator: preparation.budget.estimator,
              evidence: preparation.evidence.map((item) => item.type),
            });
            const sourceMessages = preparation.compaction?.ledgerEntry.rebuiltFromCanonical
              ? canonicalMessages
              : effectiveMessages;
            const sessionEntryId = await persistContextCompaction(
              preparation,
              sourceMessages,
              messages.length,
            );
            contextWorkingSet = {
              sourceLength: messages.length,
              messages: [...preparation.workingSet.messages],
            };
            pendingProviderCapabilityFingerprint = preparation.capability.configFingerprint;
            if (preparation.compaction) {
              emit({
                type: "context_compacted",
                beforeTokens: preparation.compaction.tokensBefore,
                afterTokens: preparation.compaction.tokensAfter,
                removedMessages: preparation.compaction.removedMessages,
                strategy: "task-state-v1",
                reason: "threshold",
                summaryFingerprint: preparation.compaction.summaryFingerprint,
                capabilityFingerprint: preparation.capability.configFingerprint,
                lineageDepth: preparation.compaction.ledgerEntry.lineageDepth,
                rebuiltFromCanonical: preparation.compaction.ledgerEntry.rebuiltFromCanonical,
                trigger: preparation.compaction.ledgerEntry.trigger,
                ...(sessionEntryId ? { sessionEntryId } : {}),
              });
            }
            return preparation.workingSet.messages;
          } catch (error) {
            const failure =
              error instanceof ContextLifecycleError
                ? error
                : new ContextLifecycleError(
                    `Context 生命周期持久化失败：${error instanceof Error ? error.message : String(error)}`,
                    "budget_exhausted",
                    "context_budget_exhausted",
                  );
            recordContextFailure(failure, messages.length);
            return messages;
          }
        },
        beforeToolCall: async (context: AgentDriverBeforeToolCallContext) => {
          const lifecycleIdentity = toolCallIdentity(agentName, stepId, context.toolCall.callId);
          const callKey = toolCapabilityCallKey(agentName, stepId, context.toolCall.callId);
          const argumentsFingerprint = fingerprintEffectReceiptValue(context.toolCall.args);
          const replayCandidateIndex = toolReplayCandidates.findIndex(
            (candidate) =>
              candidate.agent === agentName &&
              candidate.stepId === stepId &&
              candidate.tool === context.toolCall.tool &&
              candidate.argumentsFingerprint === argumentsFingerprint,
          );
          if (replayCandidateIndex >= 0) {
            const candidate = toolReplayCandidates.splice(replayCandidateIndex, 1)[0]!;
            const nextReceiptId = receiptId(runId, stepId, context.toolCall.callId);
            emit({
              type: "tool_attempt",
              attemptId: `${nextReceiptId}:attempt:${candidate.attempt}`,
              previousReceiptId: candidate.previousReceiptId,
              attempt: candidate.attempt,
              agent: agentName,
              tool: context.toolCall.tool,
              callId: context.toolCall.callId,
              ...(stepId ? { stepId } : {}),
              argumentsFingerprint,
            });
            await journal.flush("critical");
          }
          const existingCapability = capabilityByCallId.get(callKey);
          if (existingCapability && existingCapability.tool !== context.toolCall.tool) {
            capabilityFailure = new CoreMindError(
              "tool_capability_conflict",
              `Call ${agentName}/${stepId ?? "-"}/${context.toolCall.callId} 从 ${existingCapability.tool} 变更为 ${context.toolCall.tool}，Tool Capability 不可变`,
            );
            emit({ type: "error", message: capabilityFailure.message, fatal: true });
            return { block: true, reason: capabilityFailure.message };
          }
          await toolExecutionEngine.recordCall({
            ...lifecycleIdentity,
            tool: context.toolCall.tool,
          });
          let capability = existingCapability?.capability;
          if (!existingCapability) {
            capability =
              this.toolCapabilitiesByAgent.get(agentName)?.get(context.toolCall.tool) ??
              resolveToolCapability({ tool: context.toolCall.tool });
            capabilityByCallId.set(callKey, {
              tool: context.toolCall.tool,
              capability,
            });
            emit({
              type: "capability_resolved",
              agent: agentName,
              tool: context.toolCall.tool,
              callId: context.toolCall.callId,
              ...(stepId ? { stepId } : {}),
              capability,
              recoveryDisposition: recoveryDispositionFor(capability),
            });
          }
          if (!capability) {
            throw new CoreMindError(
              "tool_capability_conflict",
              `Call ${context.toolCall.callId} 缺少已解析 Tool Capability`,
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
            context.toolCall.tool,
            context.toolCall.args,
            resolvedCapability,
            this.toolEffectsByAgent.get(agentName)?.get(context.toolCall.tool),
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
                await journal.flush();
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
              tool: context.toolCall.tool,
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
              await journal.flush();
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
            tool: context.toolCall.tool,
            callId: context.toolCall.callId,
            args: context.toolCall.args,
            approvalAllowed: true,
          });
          if (extensionDecision?.denied) {
            deniedAgents.add(agentName);
            const reason = extensionDecision.denied.reason;
            emit({
              type: "policy_denied",
              agent: agentName,
              tool: context.toolCall.tool,
              reason,
            });
            await toolExecutionEngine.blockBeforeExecution(lifecycleIdentity, reason);
            return { block: true, reason, terminate: true };
          }
          if (resolvedCapability.concurrency === "parallel") {
            await toolExecutionEngine.advance(lifecycleIdentity, {
              phase: "lease_acquired",
              status: "skipped",
              reason: "Pure Local Read 不需要 Workspace Lease",
            });
          } else {
            try {
              const lease = await workspaceLeaseService.acquire({
                workspaceRoot: this.options.cwd ?? process.cwd(),
                lane: resolvedCapability.concurrency,
                owner: { runId, callId: context.toolCall.callId },
              });
              workspaceLeaseByCall.set(
                toolCapabilityCallKey(agentName, stepId, context.toolCall.callId),
                {
                  lease,
                  identity: lifecycleIdentity,
                },
              );
              emit({
                type: "workspace_lease",
                status: "acquired",
                canonicalRoot: lease.canonicalRoot,
                lane: lease.lane,
                owner: {
                  runId: lease.owner.runId,
                  callId: lease.owner.callId,
                  pid: lease.owner.pid,
                },
                agent: agentName,
                callId: context.toolCall.callId,
                ...(stepId ? { stepId } : {}),
              });
              await journal.flush("critical");
              await toolExecutionEngine.advance(lifecycleIdentity, {
                phase: "lease_acquired",
                status: "completed",
              });
            } catch (error) {
              const callKey = toolCapabilityCallKey(agentName, stepId, context.toolCall.callId);
              const held = workspaceLeaseByCall.get(callKey);
              if (held) {
                await rollbackWorkspaceLease(lifecycleIdentity).catch(() => undefined);
              }
              let leaseFailure =
                error instanceof CoreMindError
                  ? error
                  : new CoreMindError(
                      "workspace_lease_invalid",
                      error instanceof Error ? error.message : String(error),
                    );
              if (leaseFailure.code === "workspace_lease_recovery_required") {
                const inspection = await workspaceLeaseService.inspect(
                  this.options.cwd ?? process.cwd(),
                );
                if (inspection.state === "recovery_required" && inspection.owner) {
                  emit({
                    type: "workspace_lease",
                    status: "recovery_required",
                    canonicalRoot: inspection.canonicalRoot,
                    lane: resolvedCapability.concurrency,
                    owner: {
                      runId: inspection.owner.runId,
                      callId: inspection.owner.callId,
                      pid: inspection.owner.pid,
                    },
                    agent: agentName,
                    callId: context.toolCall.callId,
                    ...(stepId ? { stepId } : {}),
                  });
                  try {
                    await journal.flush("critical");
                  } catch (durabilityError) {
                    leaseFailure = durabilityFailure(durabilityError);
                  }
                }
              }
              checkpointFailure = leaseFailure;
              await toolExecutionEngine.blockBeforeExecution(
                lifecycleIdentity,
                checkpointFailure.message,
              );
              emit({ type: "error", message: checkpointFailure.message, fatal: true });
              return { block: true, reason: checkpointFailure.message, terminate: true };
            }
          }
          try {
            const idempotencyKey = receiptId(runId, stepId, context.toolCall.callId);
            const checkpoints = await checkpointManager.captureAll(
              context.toolCall.tool,
              context.toolCall.args,
              {
                operationId: operation.snapshot().operationId,
                toolCallId: context.toolCall.callId,
                idempotencyKey,
                capability: resolvedCapability,
                pathFields: this.toolEffectsByAgent.get(agentName)?.get(context.toolCall.tool)
                  ?.pathFields,
              },
            );
            if (checkpoints.length > 0) {
              checkpointByCallId.set(
                context.toolCall.callId,
                checkpoints.map((checkpoint) => checkpoint.checkpointId),
              );
              for (const checkpoint of checkpoints) {
                await journal.appendFact("checkpoint", checkpoint, { durability: "critical" });
                emit({
                  type: "checkpoint_created",
                  checkpointId: checkpoint.checkpointId,
                  tool: checkpoint.tool,
                  callId: context.toolCall.callId,
                  idempotencyKey,
                  targetPath: checkpoint.targetPath,
                  reversible: checkpoint.reversible,
                });
              }
              await journal.flush();
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
            await rollbackWorkspaceLease(lifecycleIdentity);
            return { block: true, reason: checkpointFailure.message };
          }
          effectCoordinator.markStarted(stepId, context.toolCall.callId, context.toolCall.tool);
          if (resolvedCapability.durability === "critical") {
            try {
              await journal.flush();
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
              await rollbackWorkspaceLease(lifecycleIdentity);
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
        afterToolCall: async (context: AgentDriverAfterToolCallContext) => {
          const lifecycleIdentity = toolCallIdentity(agentName, stepId, context.toolCall.callId);
          const capability = capabilityByCallId.get(
            toolCapabilityCallKey(agentName, stepId, context.toolCall.callId),
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
            tool: context.toolCall.tool,
            args: context.toolCall.args,
            isError: context.isError,
            result: context.result,
            durationMs: effectCoordinator.consumeDuration(stepId, context.toolCall.callId),
          });
          emit({
            type: "tool_execution_evidence",
            agent: agentName,
            tool: context.toolCall.tool,
            callId: context.toolCall.callId,
            ...(stepId ? { stepId } : {}),
            execution,
          });
          const artifact = extractArtifactRecord(context.result.details);
          if (artifact) {
            runContextFor(this).recordArtifact(artifact);
            emit({
              type: "artifact_created",
              artifactId: artifact.artifactId,
              status: artifact.status,
              sizeBytes: artifact.sizeBytes,
              relativePath: artifact.relativePath,
              sha256: artifact.sha256,
              mediaType: artifact.mediaType,
              redaction: artifact.redaction,
              tool: context.toolCall.tool,
              callId: context.toolCall.callId,
            });
          }
          const checkpointIds = checkpointByCallId.get(context.toolCall.callId);
          const checkpointId = checkpointIds?.[0];
          checkpointByCallId.delete(context.toolCall.callId);
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
            tool: context.toolCall.tool,
            callId: context.toolCall.callId,
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
              stepId
                ? `步骤 ${stepId} 的工具请求未获批准`
                : `Agent ${agentName} 的工具请求未获批准`,
            );
          }
        },
        onObservation: (observation) => {
          const driver = context.agent(agentName);
          if (
            observation.type === "turn_end" &&
            "contextOverflow" in observation &&
            observation.contextOverflow
          ) {
            recordContextFailure(
              new ContextLifecycleError(
                `Provider 报告 ${this.providerRuntime.model.provider}/${this.providerRuntime.model.id} 超出 Context 窗口；相同请求不会重试`,
                "provider_overflow",
                "context_budget_exhausted",
              ),
              driver?.messages().length ?? 0,
            );
          }
          if (budget.observeAgentEvent(observation)) driver?.abort();
        },
      };
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
          const messageCursor = agent.messages().length;
          await agent.prompt(effectiveInitialPrompt);
          await agent.waitForIdle();
          const messages = agent.messages();
          const agentError = extractAgentError(messages);
          if (agentError) {
            throw new CoreMindError("agent_failed", `Agent ${name} 执行失败：${agentError}`);
          }
          transcript = extractText(messages.slice(messageCursor));
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
      context.setHarnessFactory(undefined);
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
    const runtimeQuiescent = await this.waitForQuiescence(DEFAULT_QUIESCENCE_TIMEOUT_MS);
    const environmentTerminationError = context.environmentTerminationError();
    if (environmentTerminationError) {
      terminalError = new CoreMindError(
        "environment_terminate_failed",
        environmentTerminationError instanceof Error
          ? environmentTerminationError.message
          : String(environmentTerminationError),
      );
    }
    const childRunsNotQuiescent =
      !runtimeQuiescent &&
      context.currentChildRuns() !== undefined &&
      !context.currentChildRuns()?.isQuiescent();
    if (childRunsNotQuiescent) {
      terminalError ??= new CoreMindError(
        "child_run_not_quiescent",
        "Runtime 的 Child Run 未完成取消、清理与结构化 join，不能形成父级终态",
      );
    }
    if (!runtimeQuiescent && workspaceLeaseByCall.size > 0) {
      terminalError ??= new CoreMindError(
        "workspace_lease_not_quiescent",
        "Runtime 未达到静止条件，Workspace Lease 保持占用并等待恢复审计",
      );
    } else {
      for (const { identity } of [...workspaceLeaseByCall.values()]) {
        try {
          await releaseWorkspaceLease(identity);
        } catch (error) {
          terminalError ??=
            error instanceof CoreMindError
              ? error
              : new CoreMindError(
                  "workspace_lease_not_quiescent",
                  error instanceof Error ? error.message : String(error),
                );
        }
      }
    }

    let sessionFile: string | undefined;
    // D-4 方案 A：abort 后也写会话树（只写已确认部分，竞态赢家文本丢弃）；
    // 审批拒绝等 paused（loop_paused）是可在用户处置后继续的暂停态，同样应落盘已确认部分，
    // 使持久事实可重建该 Run 的请求（规格 01 §2 请求重建契约的适用范围）
    const terminalCode = terminalError instanceof CoreMindError ? terminalError.code : undefined;
    context.setSessionPersistPaused(terminalCode === "loop_paused");
    if (terminalError === undefined || journal.isAborted() || context.shouldTrimRejectedTrail()) {
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
      await journal.flush();
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
      artifactCount: context.artifactRecords().length,
    });
    // operation/input/lifecycle 收尾事实必须先形成稳定前缀，终态 Fact 才能成为最后一条。
    try {
      await journal.flush();
    } catch (error) {
      terminalError = durabilityFailure(error);
      outcome = new RunTerminalizer().terminalize(collected, terminalError);
      evaluation = createEvaluationReport(this.config.quality, metrics);
      releaseReadiness = assessReleaseReadiness(outcome, evaluation);
    }
    const terminalKind = outcome.status === "paused" ? "pause" : "finish";
    const terminalPayload = {
      operation: operation.snapshot(),
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      artifacts: context.artifactRecords(),
      extensions: context.extensions(),
      ...(outcome.status === "paused" && loopSnapshot ? { loopSnapshot } : {}),
    };
    const terminalDurabilityFailure =
      journal.factStatus().state === "poisoned" ||
      (terminalError instanceof CoreMindError &&
        (terminalError.code === "durability_unsupported" ||
          terminalError.code === "durability_barrier_failed" ||
          terminalError.code === "fact_ledger_poisoned"));
    let terminalPersisted = false;
    if (!terminalDurabilityFailure) {
      try {
        await journal.appendFact(terminalKind, terminalPayload, { durability: "critical" });
        terminalPersisted = true;
      } catch (error) {
        const finalDurabilityFailure = durabilityFailure(error);
        terminalError = finalDurabilityFailure;
        userEvents({ type: "error", message: finalDurabilityFailure.message, fatal: true });
        outcome = new RunTerminalizer().terminalize(collected, terminalError);
        evaluation = createEvaluationReport(this.config.quality, metrics);
        releaseReadiness = assessReleaseReadiness(outcome, evaluation);
      }
    }
    const persistedRecords = terminalPersisted ? await runStore.read(runId) : undefined;
    const persistedProjection = persistedRecords
      ? ProjectionEngine.project(persistedRecords)
      : undefined;
    const snapshot = terminalPersisted
      ? persistedProjection?.snapshot
      : createRunSnapshot({
          runId: trace.runId,
          operation: operation.snapshot(),
          outcome,
          metrics,
          evaluation,
          releaseReadiness,
          trace: trace.entries,
          checkpoints: checkpointManager.records,
          artifacts: context.artifactRecords(),
          extensions: context.extensions(),
        });
    if (!snapshot) {
      throw new CoreMindError("run_state_corrupt", "终态 Fact 已持久化，但无法重建 RunSnapshot");
    }
    let observability =
      persistedProjection?.observability ??
      fallbackObservability({
        outcome,
        operation: operation.snapshot(),
        telemetry: telemetryConfiguration,
      });
    if (persistedRecords) {
      const { consents: _consents, ...egressOptions } = this.options.telemetry ?? {};
      const delivery = await new TelemetryEgressController({
        policy: telemetryPolicy,
        ...egressOptions,
      }).export(persistedRecords);
      observability = {
        ...observability,
        telemetry: {
          ...observability.telemetry,
          ...delivery,
          source: observability.telemetry.source,
        },
      };
    }
    const childRuns = persistedRecords
      ? (await ProjectionEngine.projectTree(runStore, runId)).childRuns
      : undefined;
    return {
      runId: trace.runId,
      operation: snapshot.operation,
      outcome: snapshot.outcome,
      metrics: snapshot.metrics,
      evaluation: snapshot.evaluation,
      releaseReadiness: snapshot.releaseReadiness,
      trace: snapshot.trace,
      runStateFile: runStore.pathFor?.(runId),
      checkpoints: snapshot.checkpoints,
      outputs,
      messages: this.collectMessages() as unknown as Map<string, CoreMindMessage[]>,
      transcript,
      sessionFile,
      artifacts: snapshot.artifacts,
      extensions: snapshot.extensions,
      snapshot,
      observability,
      ...(childRuns ? { childRuns } : {}),
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
    const messageCursor = agent.messages().length;
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
    const messages = agent.messages();
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") {
      throw new CoreMindError("aborted", `步骤 ${request.stepId} 已中止`);
    }
    if (lastAssistant?.stopReason === "error") {
      const agentError = lastAssistant.errorMessage ?? "模型执行失败，但未提供错误详情";
      const code = classifyRetry(lastAssistant).retryable ? "provider_transient" : "agent_failed";
      throw new CoreMindError(code, `步骤 ${request.stepId} 的 Agent 执行失败：${agentError}`);
    }
    return extractText(messages.slice(messageCursor));
  }

  private abortAll(): void {
    const context = runContextFor(this);
    context.abortAgents();
    void context.cancelChildRuns("Runtime cancel").catch(() => undefined);
    void context.terminateEnvironment("Runtime cancel").catch(() => undefined);
  }

  private async applyRunControl(
    command: InternalRunControlCommand,
    context: RunContext<RuntimeHarness>,
  ): Promise<ControlApplyResult> {
    if (command.type === "steering" || command.type === "follow_up") {
      const agent = context.agent(this.mainAgentName);
      if (!agent) return "accepted";
      agent.queueControl({ type: command.type, message: command.message });
      return "applied";
    }
    return (
      this.options.applyControl?.(command) ?? {
        status: "rejected",
        reason: `当前入口不能应用 ${command.type} 控制`,
      }
    );
  }

  private collectMessages(): Map<string, CoreMindMessage[]> {
    return runContextFor(this).collectMessages();
  }

  /**
   * 等待静止（规格 03 §5）：所有 agent 已 idle ∧ 无 pending 工具结果 ∧
   * journal 无 pending flush（append 队列空且已落盘）。
   * 超时上限与 runTimeout 解耦（独立 quiescenceTimeout，默认 5s）：
   * 超时记录 quiescence_timeout 事件但不改变终态。返回是否达到静止。
   */
  async waitForQuiescence(timeoutMs: number = DEFAULT_QUIESCENCE_TIMEOUT_MS): Promise<boolean> {
    const context = runContextFor(this);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (context.isQuiescent()) return true;
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
    const context = runContextFor(this);
    const main = context.agent(this.mainAgentName);
    if (!main) return undefined;
    const cm =
      context.sessionHandle() ??
      (await CoreMindSession.open({
        dir: sessionDir(this.config, this.options.configDir),
        sessionId,
        cwd: this.options.cwd ?? process.cwd(),
      }));
    // 只追加本轮新增：恢复历史已落盘；请求级压缩的摘要与保留区已由压缩条目代表
    let messages = main.messages().slice(context.compactedPrefixEnd() ?? this.resumedContextLength);
    if (context.currentJournal()?.isAborted()) {
      // D-4 方案 A：abort 后只写已确认部分——去掉尾部未正常终止的 assistant 消息（竞态赢家文本）
      messages = trimUnconfirmedTail(messages);
    } else if (context.shouldTrimRejectedTrail()) {
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

// 类内旧执行字段仅为冻结声明布局保留；真实执行态由每个 Runtime 的 Kernel/Context 隔离持有。
interface RuntimeExecutionSlot {
  kernel?: RunKernel<RuntimeHarness, RunResult>;
  context?: RunContext<RuntimeHarness>;
}

const runtimeExecutionSlots = new WeakMap<CoreMindRuntime, RuntimeExecutionSlot>();

function executionSlotFor(runtime: CoreMindRuntime): RuntimeExecutionSlot {
  const existing = runtimeExecutionSlots.get(runtime);
  if (existing) return existing;
  const created: RuntimeExecutionSlot = {};
  runtimeExecutionSlots.set(runtime, created);
  return created;
}

function runContextFor(runtime: CoreMindRuntime): RunContext<RuntimeHarness> {
  const slot = executionSlotFor(runtime);
  const kernelContext = slot.kernel?.currentContext();
  if (kernelContext) return kernelContext;
  slot.context ??= new RunContext<RuntimeHarness>();
  return slot.context;
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

async function assertRuntimeChildPolicyAuthority(input: {
  policy: ChildRunPolicySnapshot;
  config: CoreMindConfig;
  provider: ProviderRuntime;
  executionEnvironment: ExecutionEnvironment;
  workspaceRoot: string;
  tools: ReadonlySet<string>;
  limits: ResolvedRuntimeLimits;
}): Promise<void> {
  const { policy, config, provider, executionEnvironment, workspaceRoot, tools, limits } = input;
  const canonicalRoot = await canonicalizeWorkspace(workspaceRoot);
  if (
    policy.model.providerId !== provider.model.provider ||
    policy.model.model !== provider.model.id
  ) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "Child Run 父策略模型与当前 Runtime 的实际 Provider/model 不一致",
    );
  }
  if (
    policy.workspace.canonicalRoot !== canonicalRoot ||
    policy.workspace.lease !== "shared_canonical"
  ) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "Child Run 父策略 Workspace 必须绑定当前 Runtime 的 canonical root 与共享租约",
    );
  }
  const permissions = {
    mode: config.permissions?.mode ?? "ask",
    workspaceOnly: config.permissions?.workspaceOnly ?? true,
    network: config.permissions?.network ?? "ask",
  };
  if (
    policy.permissions.mode !== permissions.mode ||
    policy.permissions.workspaceOnly !== permissions.workspaceOnly ||
    policy.permissions.network !== permissions.network ||
    [...tools].some((tool) => !policy.permissions.tools.includes(tool)) ||
    policy.permissions.paths.some(
      (allowedPath) => path.isAbsolute(allowedPath) || allowedPath.split(/[\\/]/u).includes(".."),
    ) ||
    policy.permissions.credentials.length > 0
  ) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "Child Run 父策略权限、工具、路径或凭据范围不是当前 Runtime 的真实子集",
    );
  }
  if (limits.maxTokens === undefined || limits.maxCostUsd === undefined) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "启用 Child Run 前必须为父 Runtime 显式配置 maxTokens 与 maxCostUsd",
    );
  }
  const budgetBounds = {
    tokens: limits.maxTokens,
    toolCalls: limits.maxToolCalls,
    costUsd: limits.maxCostUsd,
    wallTimeMs: limits.runTimeoutMs,
    steps: limits.maxSteps,
  };
  for (const key of Object.keys(budgetBounds) as (keyof typeof budgetBounds)[]) {
    if (budgetBounds[key] > policy.budget[key]) {
      throw new CoreMindError(
        "child_run_policy_escalation",
        `Child Runtime 的 ${key} 实际上限超过父级划拨预算`,
      );
    }
  }
  try {
    await resolveExecutionEnvironment(executionEnvironment, policy.environment);
  } catch (error) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      error instanceof Error ? error.message : String(error),
    );
  }
}

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

function traceFactDurability(
  event: CoreMindEvent,
  capabilities: ReadonlyMap<string, { tool: string; capability: ResolvedToolCapability }>,
): RunStoreDurability {
  switch (event.type) {
    case "capability_resolved":
      return "ordinary";
    case "workspace_lease":
      return "critical";
    case "tool_result": {
      const callId = event.callId;
      if (!callId) return "critical";
      return (
        capabilities.get(toolCapabilityCallKey(event.agent, event.stepId, callId))?.capability
          .durability ?? "critical"
      );
    }
    case "tool_attempt":
      return "critical";
    case "tool_lifecycle":
      return "ordinary";
    case "effect_receipt":
      return event.status === "not_started" ? "ordinary" : "critical";
    case "approval_required":
    case "approval_resolved":
    case "policy_denied":
      return "critical";
    default:
      return "ordinary";
  }
}

/** D-4 方案 A：去掉尾部未正常终止的 assistant 消息（abort 竞态赢家文本不落会话树） */
function trimUnconfirmedTail(messages: readonly CoreMindMessage[]): CoreMindMessage[] {
  let end = messages.length;
  while (end > 0) {
    const last = messages[end - 1]!;
    if (last.role === "assistant" && last.stopReason !== "stop") end -= 1;
    else break;
  }
  return messages.slice(0, end);
}

/** 审批拒绝等 paused：去掉尾部未发送的工具调用产物（toolResult 及配对的 assistant toolUse） */
function trimRejectedTrail(messages: readonly CoreMindMessage[]): CoreMindMessage[] {
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

function telemetryPolicyFromConfig(config: CoreMindConfig): TelemetryPolicy {
  return {
    mode: config.telemetry?.mode ?? "DISABLED",
    contentLevel: config.telemetry?.contentLevel ?? "metrics_only",
    allowedFields: config.telemetry?.allowedFields ?? [],
    ...(config.telemetry?.endpoint ? { endpoint: config.telemetry.endpoint } : {}),
  };
}

function fallbackObservability(input: {
  outcome: RunOutcome;
  operation: DurableOperationSnapshot;
  telemetry: ReturnType<typeof createTelemetryConfigurationFact>;
}): LocalObservabilityProjection {
  const projection = projectLocalObservability([], {
    runStatus: input.outcome.status === "paused" ? "paused" : "finished",
    resumable: input.outcome.status === "paused" && input.operation.state === "paused",
    operationState: input.operation.state,
  });
  return {
    ...projection,
    telemetry: {
      ...projection.telemetry,
      mode: input.telemetry.mode,
      contentLevel: input.telemetry.contentLevel,
      allowedFields: input.telemetry.allowedFields,
      ...(input.telemetry.endpointOrigin ? { endpointOrigin: input.telemetry.endpointOrigin } : {}),
      source: input.telemetry.mode === "DISABLED" ? "default" : "configured",
    },
  };
}

function firstKey(record: Record<string, unknown>): string | undefined {
  return Object.keys(record)[0];
}
