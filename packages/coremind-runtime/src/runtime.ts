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
import { buildTools } from "coremind-tools";
import { type AgentBuildContext, buildAgent } from "./agent-factory.js";
import { RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import {
  type CheckpointDiff,
  CheckpointManager,
  type CheckpointRecord,
  inspectCheckpoint as inspectStoredCheckpoint,
  restoreCheckpoint as restoreStoredCheckpoint,
} from "./checkpoint.js";
import { ContextProtector } from "./context.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractAgentError, extractText } from "./events.js";
import { LoopRunner, type LoopStepRequest } from "./loop-runner.js";
import { Orchestrator, type StepOutput } from "./orchestrator.js";
import { buildProviderRuntime, type ProviderRuntime } from "./provider.js";
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
import {
  FileRunStore,
  fingerprintRunConfig,
  prepareRunResume,
  RunStateJournal,
  type RunStore,
} from "./run-state.js";
import { RunTerminalizer } from "./run-terminalizer.js";
import { CoreMindSession } from "./session.js";
import { type ApprovalDecision, type ToolApprovalRequest, ToolPolicy } from "./tool-policy.js";
import { type CoreMindTraceEvent, TraceRecorder } from "./trace.js";

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
  /** 通过稳定 CoreMind 契约注入的 TypeScript 或跨语言工具。 */
  toolDefinitions?: CoreMindToolDefinition[];
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
  messages: Map<string, AgentMessage[]>;
  /** 主输出文本（CLI --print 直接打印） */
  transcript: string;
  /** 会话文件路径（已落盘时） */
  sessionFile?: string;
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
  private activeHarnessFactory?: (agentName: string) => AgentBuildContext["harness"];

  private constructor(
    private readonly config: CoreMindConfig,
    private readonly agentConfigs: Map<string, AgentConfig>,
    private readonly toolsByAgent: Map<string, AgentTool[]>,
    private readonly toolEffectsByAgent: Map<string, Map<string, ToolEffectDeclaration>>,
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
    const skillsByAgent = new Map<string, string[]>();
    const externalTools = (options.toolDefinitions ?? []).map(adaptCoreMindTool);
    // 自定义技能（生态机制）：配置文件所在目录的 skills/ 下，每个子目录的 README.md 即一个技能
    const customSkills = await loadDirectorySkills(path.join(configDir, "skills"));
    for (const [name, agentCfg] of Object.entries(config.agents)) {
      const toolConfigs = (agentCfg.tools?.length ?? 0) > 0 ? agentCfg.tools : config.tools;
      const { tools, warnings, effects } = await buildTools(toolConfigs ?? [], {
        cwd,
        configDir,
        env,
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
      providerRuntime,
      options,
      sessionMessages,
      resumedContextLength,
      skillsByAgent,
    );
  }

  /** 按名字创建独立 Agent 实例（每次新实例，消息历史独立） */
  createAgent(
    name: string,
    onEvent: (event: CoreMindEvent) => void = this.options.events ?? (() => {}),
  ): Agent | undefined {
    const agentCfg = this.agentConfigs.get(name);
    if (!agentCfg) return undefined;
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
      harness: this.activeHarnessFactory?.(name),
    });
    this.lastAgents.set(name, agent);
    return agent;
  }

  /** 查询配置中是否存在 Agent，供交互会话在首轮前快速失败。 */
  hasAgent(name: string): boolean {
    return this.agentConfigs.has(name);
  }

  /** 返回交互会话应继承的恢复消息副本。 */
  initialMessagesFor(name: string): AgentMessage[] {
    return name === this.mainAgentName ? [...(this.sessionMessages ?? [])] : [];
  }

  /**
   * 把一轮交互对话作为完整 Run 执行。
   * 因此 chat/TUI 与无头 run 共用预算、权限、checkpoint、Trace 和失败语义。
   */
  async runAgentTurn(
    agentName: string,
    message: string,
    history: AgentMessage[],
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
      this.providerRuntime,
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
    const started = performance.now();
    const runStore =
      this.options.runStore ??
      new FileRunStore(path.join(this.options.configDir, ".coremind", "runs"));
    const configFingerprint = fingerprintRunConfig(this.config);
    const resumePlan = this.options.resumeRunId
      ? prepareRunResume(
          await runStore.read(this.options.resumeRunId),
          configFingerprint,
          this.options.initialPrompt,
        )
      : undefined;
    const runId = resumePlan?.runId ?? randomUUID();
    const effectiveInitialPrompt = resumePlan?.initialPrompt ?? this.options.initialPrompt;
    const journal = new RunStateJournal(runId, runStore, resumePlan?.nextJournalSequence ?? 0);
    if (resumePlan) {
      journal.resume({
        completedStepIds: [...resumePlan.completedSteps.keys()],
        resumedAt: new Date().toISOString(),
      });
      await journal.flush();
    } else {
      await journal.start({
        configName: this.config.name,
        schemaVersion: this.config.schemaVersion,
        configFingerprint,
        initialPrompt: this.options.initialPrompt,
        sessionId: this.options.sessionId,
      });
    }
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
    const activeToolEffects = new Map<
      string,
      { idempotencyKey: string; tool: string; stepId?: string }
    >();
    const recordEvent = (event: CoreMindEvent) => {
      collected.push(event);
      trace.record(event);
      userEvents(event);
    };
    const emit = (event: CoreMindEvent) => {
      const enriched =
        event.type === "tool_call" && event.callId && !event.idempotencyKey
          ? { ...event, idempotencyKey: effectIdempotencyKey(runId, event.stepId, event.callId) }
          : event;
      recordEvent(enriched);
      if (enriched.type === "tool_call" && enriched.callId && enriched.idempotencyKey) {
        const effect = {
          idempotencyKey: enriched.idempotencyKey,
          tool: enriched.tool,
          ...(enriched.stepId ? { stepId: enriched.stepId } : {}),
        };
        activeToolEffects.set(effectCallKey(enriched.stepId, enriched.callId), effect);
        recordEvent({ type: "effect_receipt", ...effect, status: "started" });
      }
      if (enriched.type === "tool_result" && enriched.callId) {
        const callKey = effectCallKey(enriched.stepId, enriched.callId);
        const effect = activeToolEffects.get(callKey) ?? {
          idempotencyKey: effectIdempotencyKey(runId, enriched.stepId, enriched.callId),
          tool: enriched.tool,
          ...(enriched.stepId ? { stepId: enriched.stepId } : {}),
        };
        activeToolEffects.delete(callKey);
        recordEvent({
          type: "effect_receipt",
          ...effect,
          status: enriched.isError ? "unknown" : "committed",
        });
      }
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
    const checkpointByCallId = new Map<string, string>();
    const contextWindow = this.providerRuntime.model.contextWindow;
    const contextProtector = new ContextProtector(
      {
        contextWindow,
        reserveTokens: Math.min(16_384, Math.max(1_024, Math.floor(contextWindow * 0.15))),
        keepRecentTokens: Math.min(20_000, Math.max(2_048, Math.floor(contextWindow * 0.25))),
      },
      (result) =>
        emit({
          type: "context_compacted",
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          removedMessages: result.removedMessages,
        }),
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
        }),
      onApprovalResolved: (request, decision) =>
        emit({
          type: "approval_resolved",
          approvalId: request.approvalId,
          runId: request.runId,
          decision,
        }),
    });
    this.activeHarnessFactory = (agentName) => ({
      maxRetries: loop ? 0 : limits.maxRetries,
      transformContext: async (messages) => contextProtector.transform(messages),
      beforeToolCall: async (context: BeforeToolCallContext) => {
        const blockedByBudget = budget.beforeToolCall();
        if (blockedByBudget) return blockedByBudget;
        const decision = await policy.authorize(
          agentName,
          context.toolCall.name,
          context.args,
          this.toolEffectsByAgent.get(agentName)?.get(context.toolCall.name),
        );
        if (!decision.allowed) {
          emit({
            type: "policy_denied",
            agent: agentName,
            tool: context.toolCall.name,
            reason: decision.reason,
          });
          return { block: true, reason: decision.reason };
        }
        try {
          const checkpoint = await checkpointManager.capture(context.toolCall.name, context.args);
          if (checkpoint) {
            checkpointByCallId.set(context.toolCall.id, checkpoint.checkpointId);
            journal.checkpoint(checkpoint);
            emit({
              type: "checkpoint_created",
              checkpointId: checkpoint.checkpointId,
              tool: checkpoint.tool,
              targetPath: checkpoint.targetPath,
              reversible: checkpoint.reversible,
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
          emit({ type: "error", message: checkpointFailure.message, fatal: true });
          return { block: true, reason: checkpointFailure.message };
        }
        return undefined;
      },
      afterToolCall: async (context: AfterToolCallContext) => {
        const checkpointId = checkpointByCallId.get(context.toolCall.id);
        checkpointByCallId.delete(context.toolCall.id);
        if (checkpointId) {
          try {
            await checkpointManager.markApplied(checkpointId);
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
        return checkpointFailure ? { terminate: true } : budgetResult;
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
                this.createAgent(name, (event) =>
                  emit(stepId ? ({ ...event, stepId } as CoreMindEvent) : event),
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
      if (checkpointFailure) throw checkpointFailure;
      budget.throwIfExceeded();
    } catch (error) {
      terminalError = checkpointFailure ?? error;
      try {
        if (!checkpointFailure) budget.throwIfExceeded();
      } catch (budgetError) {
        terminalError = budgetError;
      }
    } finally {
      this.activeHarnessFactory = undefined;
    }

    let sessionFile: string | undefined;
    if (terminalError === undefined) {
      try {
        sessionFile = await this.persistSession();
      } catch (error) {
        terminalError = error;
      }
    }
    const allMessages = [...this.collectMessages().values()].flat();
    if (terminalError !== undefined && transcript.length === 0) {
      transcript = extractText(allMessages);
    }
    const metrics = analyzeRunMetrics(
      collected,
      allMessages,
      performance.now() - started,
      transcript.length,
    );
    const outcome = new RunTerminalizer().terminalize(collected, terminalError);
    const evaluation = createEvaluationReport(this.config.quality, metrics);
    const releaseReadiness = assessReleaseReadiness(outcome, evaluation);
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
      journal.pause({
        outcome,
        metrics,
        evaluation,
        releaseReadiness,
        ...(loopSnapshot ? { loopSnapshot } : {}),
      });
    } else {
      journal.finish({ outcome, metrics, evaluation, releaseReadiness });
    }
    await journal.flush();
    return {
      runId: trace.runId,
      outcome,
      metrics,
      evaluation,
      releaseReadiness,
      trace: trace.entries,
      runStateFile: runStore.pathFor?.(runId),
      checkpoints: checkpointManager.records,
      outputs,
      messages: this.collectMessages(),
      transcript,
      sessionFile,
    };
  }

  private async runWithGuard<T>(
    timeoutMs: number,
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
      void Promise.resolve(onGuardError?.(error))
        .catch(() => undefined)
        .then(() => {
          reject(error);
          this.abortAll();
        });
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
    const agent = this.createAgent(request.agent, (event) =>
      emit({ ...event, stepId: request.stepId } as CoreMindEvent),
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

  /** 会话配置开启时，把主 agent 本轮新增消息追加落盘（返回会话文件路径） */
  async persistSession(): Promise<string | undefined> {
    const sessionId = this.options.sessionId;
    const session = this.config.session;
    if (!sessionId || !session?.enabled) return undefined;
    const main = this.lastAgents.get(this.mainAgentName);
    if (!main) return undefined;
    const cm = await CoreMindSession.open({
      dir: sessionDir(this.config, this.options.configDir),
      sessionId,
      cwd: this.options.cwd ?? process.cwd(),
    });
    // 只追加本轮新增（恢复时注入的历史已在会话文件中，避免重复）
    await cm.appendMessages(main.state.messages.slice(this.resumedContextLength));
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

function effectCallKey(stepId: string | undefined, callId: string): string {
  return `${stepId ?? "agent"}:${callId}`;
}

function effectIdempotencyKey(runId: string, stepId: string | undefined, callId: string): string {
  return stepId ? `${runId}:${stepId}:${callId}` : `${runId}:${callId}`;
}
