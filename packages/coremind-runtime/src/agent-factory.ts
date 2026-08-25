import {
  type AfterToolCallContext,
  type AfterToolCallResult,
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { AgentConfig } from "coremind-config";
import { buildStableContextPrefix } from "./context.js";
import { type CoreMindEvent, normalizeEvent } from "./events.js";

export interface AgentContextContract {
  stablePrefix: string;
  toolSchemas: unknown[];
}

export interface AgentBuildContext {
  /** 共享模型集合（所有 agent 同一实例，streamFn 绑定） */
  models: Models;
  model: Model<any>;
  tools: AgentTool[];
  /** agent 名（注入归一化事件） */
  agentName: string;
  /** 事件转发 */
  onEvent: (event: CoreMindEvent) => void;
  /** 会话历史（断点续聊恢复用） */
  sessionMessages?: AgentMessage[];
  /** 配置 apiKeyEnv 时的 key 覆盖（内置 provider） */
  apiKeyOverride?: string;
  /** 注入的专业技能内容（skills/<id>/README.md，附加到系统提示词） */
  skillsContent?: string[];
  /** 不含凭据且在一轮 Run 内不变的事实。 */
  stableFacts?: Record<string, string | number | boolean>;
  /** Provider 目录是否明确声明缓存计费能力。 */
  promptCacheStatus?: "available" | "unavailable";
  /** CoreMind Harness 钩子；由每次 Run 注入，不写入用户配置。 */
  harness?: {
    maxRetries?: number;
    registerContextContract?: (contract: AgentContextContract) => void;
    beforeModelRequest?: () => void;
    /** Provider Runtime 已接受最终 Working Set；这是本地调度证据，不声明远端已收包。 */
    onModelRequestDispatched?: (request: {
      providerId: string;
      modelId: string;
      messages: readonly unknown[];
    }) => void;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    beforeToolCall?: (
      context: BeforeToolCallContext,
      signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall?: (
      context: AfterToolCallContext,
      signal?: AbortSignal,
    ) => Promise<AfterToolCallResult | undefined>;
    executeTool?: (
      tool: AgentTool,
      ...args: Parameters<AgentTool["execute"]>
    ) => ReturnType<AgentTool["execute"]>;
    onAgentEvent?: (event: AgentEvent, agent: Agent) => void;
  };
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
        execute: (...args: Parameters<AgentTool["execute"]>) =>
          ctx.harness!.executeTool!(tool, ...args),
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
      messages: ctx.sessionMessages ?? [],
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
    transformContext: ctx.harness?.transformContext,
    beforeToolCall: ctx.harness?.beforeToolCall,
    afterToolCall: ctx.harness?.afterToolCall,
  });

  // 事件归一化转发（agent 名由上下文注入，stepId 由编排层补充）
  agent.subscribe((event) => {
    ctx.harness?.onAgentEvent?.(event, agent);
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
