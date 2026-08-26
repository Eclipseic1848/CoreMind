import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { isContextOverflow, type Model, type Models } from "@earendil-works/pi-ai";
import type { AgentConfig } from "coremind-config";
import type {
  AgentDriver,
  AgentDriverControl,
  AgentDriverHarness,
  AgentDriverObservation,
  AgentDriverStatus,
  AgentDriverToolCall,
  AgentDriverTurnObservation,
} from "./agent-driver.js";
import { buildStableContextPrefix } from "./context.js";
import { normalizeDependencyUsage } from "./dependency-adapter.js";
import { type CoreMindEvent, normalizeEvent } from "./events.js";
import type { CoreMindMessage } from "./public-message.js";

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
  const stablePrefix = buildStableContextPrefix({
    projectInstructions: agentCfg.systemPrompt ?? "",
    tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
    stableFacts: ctx.stableFacts,
    skillsContent: ctx.skillsContent,
  });
  ctx.onEvent({
    type: "context_prefix",
    agent: ctx.agentName,
    fingerprint: stablePrefix.fingerprint,
  });
  ctx.harness?.registerContextContract?.({
    stablePrefix: stablePrefix.text,
    toolSchemas: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  });
  const agent = new Agent({
    initialState: {
      systemPrompt: stablePrefix.text,
      model: ctx.model,
      tools,
      messages: (ctx.sessionMessages ?? []) as unknown as AgentMessage[],
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
        messages: c.messages,
      });
      return response;
    },
    toolExecution: "parallel",
    transformContext: ctx.harness?.transformContext
      ? async (messages, signal) =>
          (await ctx.harness!.transformContext!(
            messages as unknown as CoreMindMessage[],
            signal,
          )) as unknown as AgentMessage[]
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
    shouldStopAfterTurn: ctx.harness?.shouldStopAfterTurn,
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

  // 事件归一化转发（agent 名由上下文注入，stepId 由编排层补充）
  const activeDriverCalls = new Map<string, AgentDriverToolCall>();
  agent.subscribe((event) => {
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
  const agent = buildAgent(agentCfg, ctx);
  return new PiAgentDriver(agent, ctx.harness);
}

class PiAgentDriver implements AgentDriver {
  private queuedControls = 0;

  constructor(
    private readonly agent: Agent,
    private readonly harness: AgentDriverHarness | undefined,
  ) {
    agent.subscribe((event) => {
      if (event.type === "agent_end") this.queuedControls = 0;
    });
  }

  prompt(input: string): Promise<void> {
    return this.agent.prompt(input);
  }

  async waitForIdle(): Promise<void> {
    await this.agent.waitForIdle();
    this.harness?.throwIfDenied?.();
    this.harness?.throwIfContextFailed?.();
  }

  messages(): CoreMindMessage[] {
    return [...this.agent.state.messages] as unknown as CoreMindMessage[];
  }

  status(): AgentDriverStatus {
    return {
      running: this.agent.state.isStreaming,
      pendingToolCalls: this.agent.state.pendingToolCalls.size,
      queuedControls: this.queuedControls,
    };
  }

  abort(): void {
    this.agent.abort();
  }

  queueControl(control: AgentDriverControl): void {
    const message: AgentMessage = {
      role: "user",
      content: control.message,
      timestamp: Date.now(),
    };
    this.queuedControls += 1;
    if (control.type === "steering") this.agent.steer(message);
    else this.agent.followUp(message);
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
