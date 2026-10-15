import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
  createInitialSystemMessage,
  isContextOverflow,
  type Model,
  type Models,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { AgentConfig } from "coremind-config";
import type {
  AgentDriver,
  AgentDriverContextContract,
  AgentDriverControl,
  AgentDriverDeclarationSelection,
  AgentDriverHarness,
  AgentDriverObservation,
  AgentDriverStatus,
  AgentDriverToolCall,
  AgentDriverTurnObservation,
} from "./agent-driver.js";
import { buildStableContextPrefix } from "./context.js";
import { normalizeDependencyUsage } from "./dependency-adapter.js";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, normalizeEvent } from "./events.js";
import type { InputId } from "./input-receipt.js";
import type { CoreMindMessage } from "./public-message.js";
import { convertToLlm, type AgentMessage as SessionMessage } from "./session-v4/index.js";

const adapterHistories = new WeakMap<Agent, () => CoreMindMessage[]>();

export interface AgentBuildContext {
  /** 共享模型集合（所有 agent 同一实例，streamFn 绑定） */
  models: Models;
  model: Model<any>;
  tools: AgentTool[];
  /** agent 名（注入归一化事件） */
  agentName: string;
  /** 事件转发 */
  onEvent: (event: CoreMindEvent) => void;
  /** CoreMind-owned Driver 观测；不把底层 AgentEvent 暴露给调用方。 */
  onObservation?: (observation: AgentDriverObservation | AgentDriverTurnObservation) => void;
  /** 会话历史（断点续聊恢复用） */
  sessionMessages?: CoreMindMessage[];
  /** 配置 apiKeyEnv 时的 key 覆盖（内置 provider） */
  apiKeyOverride?: string;
  /** 注入的专业技能内容（skills/<id>/README.md，附加到系统提示词） */
  skillsContent?: string[];
  /** 不含凭据且在一轮 Run 内不变的事实。 */
  stableFacts?: Record<string, string | number | boolean>;
  /** Provider 目录是否明确声明缓存计费能力。 */
  promptCacheStatus?: "available" | "unavailable";
  /** CoreMind Harness 钩子；由每次 Run 注入，不写入用户配置。 */
  harness?: AgentDriverHarness;
}

/**
 * 把 agent 配置构建为可运行的 Agent 实例。
 * 关键点：显式绑定 models.streamSimple 为 streamFn，自定义 baseUrl/headers 才能生效。
 */
export function buildAgent(agentCfg: AgentConfig, ctx: AgentBuildContext): Agent {
  const { temperature, maxTokens } = agentCfg.options ?? {};
  const tools = ctx.harness?.executeTool
    ? ctx.tools.map((tool) => ({
        ...tool,
        execute: async (...args: Parameters<AgentTool["execute"]>) => {
          const [callId, params, signal, onUpdate] = args;
          return (await ctx.harness!.executeTool!({
            call: { callId, tool: tool.name, args: params },
            signal,
            invoke: () =>
              tool.execute(callId, params, signal, onUpdate) as ReturnType<AgentTool["execute"]>,
          })) as Awaited<ReturnType<AgentTool["execute"]>>;
        },
      }))
    : ctx.tools;
  const catalog = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    declaration: toToolDeclaration(tool),
  }));
  const selection = ctx.harness?.registerDeclarationCatalog?.(catalog);
  const ownedSystems = new WeakSet<object>();
  const makeFrame = (selected?: AgentDriverDeclarationSelection) => {
    const selectedTools = selected
      ? selected.names.map((name) => {
          const matching = tools.filter((tool) => tool.name === name);
          if (matching.length !== 1)
            throw new CoreMindError("tool_capability_conflict", "工具声明不属于唯一允许目录");
          return matching[0]!;
        })
      : tools;
    if (
      selected &&
      (!Number.isSafeInteger(selected.generation) ||
        selected.generation < 0 ||
        !/^[0-9a-f]{64}$/u.test(selected.fingerprint) ||
        new Set(selected.names).size !== selected.names.length)
    ) {
      throw new CoreMindError("tool_capability_conflict", "工具声明身份非法");
    }
    const stablePrefix = buildStableContextPrefix({
      projectInstructions: agentCfg.systemPrompt ?? "",
      tools: selectedTools.map((tool) => ({ name: tool.name, description: tool.description })),
      stableFacts: ctx.stableFacts,
      skillsContent: ctx.skillsContent,
    });
    const toolSchemas = selected
      ? selectedTools.map((tool) => catalog.find((entry) => entry.name === tool.name)!.declaration)
      : catalog.map((entry) => entry.declaration);
    const prefix = createInitialSystemMessage(stablePrefix.text, toolSchemas)!;
    ownedSystems.add(prefix);
    const contract: AgentDriverContextContract = {
      stablePrefix: stablePrefix.text,
      toolSchemas,
      ...(selected
        ? { toolDiscovery: { generation: selected.generation, fingerprint: selected.fingerprint } }
        : {}),
    };
    return {
      selection: selected,
      tools: selectedTools,
      stablePrefix,
      toolSchemas,
      prefix,
      contract,
    };
  };
  let frame = makeFrame(selection);
  const history = <T extends { role?: string }>(messages: T[]): T[] => {
    if (!selection) return withoutAdapterPrefix(messages, frame.prefix as unknown as T);
    if (!messages[0] || !ownedSystems.has(messages[0])) {
      throw new CoreMindError("tool_capability_conflict", "模型执行上下文缺少当前声明首部");
    }
    return messages.filter((message) => {
      if (ownedSystems.has(message)) return false;
      if (message.role === "system" && ("toolsAdded" in message || "toolsRemoved" in message)) {
        throw new CoreMindError("tool_capability_conflict", "历史消息含未归属的工具声明");
      }
      return true;
    });
  };
  ctx.onEvent({
    type: "context_prefix",
    agent: ctx.agentName,
    fingerprint: frame.stablePrefix.fingerprint,
  });
  ctx.harness?.registerContextContract?.(frame.contract);
  // 执行依赖把系统合同放进消息首部；会话、预算和回放仍只处理独立的历史正文。
  const agent: Agent = new Agent({
    initialState: {
      systemPrompt: frame.stablePrefix.text,
      model: ctx.model,
      tools: frame.tools,
      messages: [frame.prefix, ...((ctx.sessionMessages ?? []) as unknown as AgentMessage[])],
      thinkingLevel: agentCfg.options?.thinkingLevel,
    },
    // 每次流式请求注入：apiKey 覆盖（apiKeyEnv）、temperature/maxTokens（agent options）
    streamFn: (m, c, o) => {
      ctx.harness?.beforeModelRequest?.();
      o?.signal?.throwIfAborted();
      const response = ctx.models.streamSimple(m, c, {
        ...o,
        ...(ctx.harness?.maxRetries !== undefined ? { maxRetries: ctx.harness.maxRetries } : {}),
        ...(ctx.apiKeyOverride ? { apiKey: ctx.apiKeyOverride } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });
      ctx.harness?.onModelRequestDispatched?.({
        providerId: m.provider,
        modelId: m.id,
        messages: history(c.messages),
      });
      return response;
    },
    toolExecution: "parallel",
    convertToLlm: (messages) => [
      frame.prefix,
      ...convertToLlm(history(messages) as SessionMessage[]),
    ],
    transformContext: ctx.harness?.transformContext
      ? async (messages, signal) => [
          frame.prefix,
          ...((await ctx.harness!.transformContext!(
            history(messages) as unknown as CoreMindMessage[],
            signal,
          )) as unknown as AgentMessage[]),
        ]
      : undefined,
    prepareRequest:
      selection && ctx.harness?.prepareRequest
        ? async (request, signal) => {
            let candidate: ReturnType<typeof makeFrame> | undefined;
            const selected = await ctx.harness!.prepareRequest!((next) => {
              if (candidate)
                throw new CoreMindError("tool_capability_conflict", "单次请求只能准备一份声明帧");
              candidate = makeFrame(next);
              return candidate.contract;
            }, signal);
            signal?.throwIfAborted();
            if ((candidate && selected !== candidate.selection) || (selected && !candidate)) {
              throw new CoreMindError("tool_capability_conflict", "声明确认没有返回原始候选身份");
            }
            const requestHistory = history(request.context.messages);
            if (candidate) {
              const stateHistory = history(agent.state.messages);
              const changed = frame.stablePrefix.fingerprint !== candidate.stablePrefix.fingerprint;
              frame = candidate;
              agent.state.tools = frame.tools;
              agent.state.messages = [frame.prefix, ...stateHistory];
              ctx.harness?.registerContextContract?.(frame.contract);
              if (changed)
                ctx.onEvent({
                  type: "context_prefix",
                  agent: ctx.agentName,
                  fingerprint: frame.stablePrefix.fingerprint,
                });
            }
            return {
              context: {
                ...request.context,
                tools: frame.tools,
                messages: [frame.prefix, ...requestHistory],
              },
            };
          }
        : undefined,
    beforeToolCall: ctx.harness?.beforeToolCall
      ? (context, signal) =>
          ctx.harness!.beforeToolCall!(
            {
              toolCall: {
                callId: context.toolCall.id,
                tool: context.toolCall.name,
                args: context.args,
              },
            },
            signal,
          )
      : undefined,
    finishTurn: ctx.harness?.shouldStopAfterTurn
      ? async ({ message }) => {
          if (message.stopReason === "error" || message.stopReason === "aborted") return;
          if (await ctx.harness!.shouldStopAfterTurn!()) return { action: "end" };
        }
      : undefined,
    afterToolCall: ctx.harness?.afterToolCall
      ? async (context, signal) =>
          (await ctx.harness!.afterToolCall!(
            {
              toolCall: {
                callId: context.toolCall.id,
                tool: context.toolCall.name,
                args: context.args,
              },
              result: context.result,
              isError: context.isError,
            },
            signal,
          )) as Awaited<ReturnType<NonNullable<Agent["afterToolCall"]>>>
      : undefined,
  });
  adapterHistories.set(agent, () => history(agent.state.messages) as unknown as CoreMindMessage[]);

  // 事件归一化转发（agent 名由上下文注入，stepId 由编排层补充）
  const activeDriverCalls = new Map<string, AgentDriverToolCall>();
  agent.subscribe((event) => {
    if (selection && event.type === "message_end" && event.message.role === "system") {
      ownedSystems.add(event.message);
    }
    const observation = normalizeDriverObservation(
      event,
      ctx.model.contextWindow,
      activeDriverCalls,
    );
    if (observation) {
      ctx.harness?.onObservation?.(observation);
      ctx.onObservation?.(observation);
    }
    const coreEvent = normalizeEvent(event);
    if (coreEvent) {
      const enriched =
        coreEvent.type === "turn_end" && ctx.promptCacheStatus
          ? { ...coreEvent, promptCacheStatus: ctx.promptCacheStatus }
          : coreEvent;
      ctx.onEvent({ ...enriched, agent: ctx.agentName } as CoreMindEvent);
    }
  });

  return agent;
}

/** 生产 Adapter：把 P3 Agent 生命周期收敛到 CoreMind 私有 AgentDriver seam。 */
export function buildAgentDriver(agentCfg: AgentConfig, ctx: AgentBuildContext): AgentDriver {
  let requestFailure: unknown;
  let driver: ModelAgentDriver | undefined;
  const agent = buildAgent(agentCfg, {
    ...ctx,
    harness: {
      ...ctx.harness,
      onObservation: (observation) => {
        if (observation.type === "agent_end") driver?.endControlAdmission();
        ctx.harness?.onObservation?.(observation);
      },
      beforeModelRequest: () => {
        try {
          ctx.harness?.beforeModelRequest?.();
        } catch (error) {
          // 上游会把请求前的异常转为模型消息；保留本地拒绝的类型化原因。
          requestFailure = error;
          throw error;
        }
      },
    },
  });
  const prepareRequest = agent.prepareRequest;
  if (prepareRequest)
    agent.prepareRequest = async (...args) => {
      try {
        const update = await prepareRequest(...args);
        return update || undefined;
      } catch (error) {
        requestFailure = error;
        throw error;
      }
    };
  driver = new ModelAgentDriver(agent, ctx.harness, () => requestFailure, ctx.onObservation);
  return driver;
}

function withoutAdapterPrefix<T>(messages: T[], prefix: T): T[] {
  if (messages[0] !== prefix) throw new Error("模型执行上下文缺少已注册的系统首部");
  return messages.slice(1);
}

class ModelAgentDriver implements AgentDriver {
  private acceptingControls = true;
  private readonly controlIds = new Set<InputId>();
  private readonly pendingControls = new Map<AgentMessage, InputId>();
  private promptRunning = false;

  constructor(
    private readonly agent: Agent,
    private readonly harness: AgentDriverHarness | undefined,
    private readonly requestFailure: () => unknown,
    private readonly onObservation: AgentBuildContext["onObservation"],
  ) {
    agent.subscribe((event) => {
      if (event.type !== "message_end" || event.message.role !== "user") return;
      const inputId = this.pendingControls.get(event.message);
      if (inputId === undefined) return;
      this.pendingControls.delete(event.message);
      this.observeControl({ type: "control_consumed", inputId });
    });
  }

  async prompt(input: string): Promise<void> {
    this.promptRunning = true;
    this.acceptingControls = true;
    try {
      if (this.harness?.beforePrompt) await this.harness.beforePrompt();
      await this.agent.prompt(input);
      await this.agent.waitForIdle();
    } finally {
      this.acceptingControls = false;
      this.promptRunning = false;
    }
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
    const failure = this.requestFailure();
    if (failure !== undefined) throw failure;
    this.harness?.throwIfDenied?.();
    this.harness?.throwIfContextFailed?.();
  }

  messages(): CoreMindMessage[] {
    return adapterHistories.get(this.agent)!();
  }

  status(): AgentDriverStatus {
    return {
      running: this.promptRunning || this.agent.state.isStreaming,
      pendingToolCalls: this.agent.state.pendingToolCalls.size,
      queuedControls: this.pendingControls.size,
    };
  }

  abort(): void {
    this.agent.abort();
  }

  canAcceptControl(): boolean {
    return this.acceptingControls;
  }

  endControlAdmission(): void {
    this.acceptingControls = false;
  }

  queueControl(control: AgentDriverControl): void {
    if (this.controlIds.has(control.inputId)) return;
    const message: AgentMessage = {
      role: "user",
      content: control.message,
      timestamp: Date.now(),
    };
    this.controlIds.add(control.inputId);
    this.pendingControls.set(message, control.inputId);
    if (control.type === "steering") this.agent.steer(message);
    else this.agent.followUp(message);
  }

  clearQueuedControls(): void {
    this.agent.clearAllQueues();
    const discarded = [...this.pendingControls.values()];
    this.pendingControls.clear();
    for (const inputId of discarded) this.observeControl({ type: "control_discarded", inputId });
  }

  private observeControl(observation: AgentDriverObservation): void {
    this.harness?.onObservation?.(observation);
    this.onObservation?.(observation);
  }
}

function normalizeDriverObservation(
  event: AgentEvent,
  contextWindow: number,
  activeCalls?: Map<string, AgentDriverToolCall>,
): AgentDriverObservation | AgentDriverTurnObservation | undefined {
  switch (event.type) {
    case "agent_start":
      return { type: event.type };
    case "agent_end":
      activeCalls?.clear();
      return { type: event.type };
    case "turn_end": {
      const usage =
        event.message.role === "assistant" && event.message.usage
          ? normalizeDependencyUsage(event.message.usage)
          : { totalTokens: 0, contextTokens: 0, costUsd: 0 };
      return {
        type: "turn_end",
        message: event.message as unknown as CoreMindMessage,
        ...usage,
        requestsAnotherTurn:
          event.message.role === "assistant" &&
          event.message.content.some((item) => item.type === "toolCall"),
        contextOverflow:
          event.message.role === "assistant" && isContextOverflow(event.message, contextWindow),
      };
    }
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta" &&
        event.assistantMessageEvent.delta.length > 0
        ? { type: "text_delta", delta: event.assistantMessageEvent.delta }
        : undefined;
    case "tool_execution_start": {
      const call = {
        callId: event.toolCallId,
        tool: event.toolName,
        args: event.args,
      };
      activeCalls?.set(event.toolCallId, call);
      return {
        type: "tool_execution_start",
        call,
      };
    }
    case "tool_execution_end": {
      const call = activeCalls?.get(event.toolCallId) ?? {
        callId: event.toolCallId,
        tool: event.toolName,
        args: undefined,
      };
      activeCalls?.delete(event.toolCallId);
      return {
        type: "tool_execution_end",
        call,
        result: event.result,
        isError: event.isError,
      };
    }
    default:
      return undefined;
  }
}
