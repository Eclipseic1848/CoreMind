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
import { type CoreMindEvent, normalizeEvent } from "./events.js";

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
  /** CoreMind Harness 钩子；由每次 Run 注入，不写入用户配置。 */
  harness?: {
    maxRetries?: number;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    beforeToolCall?: (
      context: BeforeToolCallContext,
      signal?: AbortSignal,
    ) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall?: (
      context: AfterToolCallContext,
      signal?: AbortSignal,
    ) => Promise<AfterToolCallResult | undefined>;
    onAgentEvent?: (event: AgentEvent, agent: Agent) => void;
  };
}

/**
 * 把 agent 配置构建为可运行的 Agent 实例。
 * 关键点：显式绑定 models.streamSimple 为 streamFn，自定义 baseUrl/headers 才能生效。
 */
export function buildAgent(agentCfg: AgentConfig, ctx: AgentBuildContext): Agent {
  const { temperature, maxTokens } = agentCfg.options ?? {};
  // 技能注入：专业技能段附加到系统提示词（技能提上限）
  const skillsBlock =
    ctx.skillsContent && ctx.skillsContent.length > 0
      ? `\n\n# 专业技能\n${ctx.skillsContent.join("\n\n---\n\n")}`
      : "";
  const agent = new Agent({
    initialState: {
      systemPrompt: `${agentCfg.systemPrompt}${skillsBlock}`,
      model: ctx.model,
      tools: ctx.tools,
      messages: ctx.sessionMessages ?? [],
      thinkingLevel: agentCfg.options?.thinkingLevel,
    },
    // 每次流式请求注入：apiKey 覆盖（apiKeyEnv）、temperature/maxTokens（agent options）
    streamFn: (m, c, o) =>
      ctx.models.streamSimple(m, c, {
        ...o,
        ...(ctx.harness?.maxRetries !== undefined ? { maxRetries: ctx.harness.maxRetries } : {}),
        ...(ctx.apiKeyOverride ? { apiKey: ctx.apiKeyOverride } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }),
    toolExecution: "parallel",
    transformContext: ctx.harness?.transformContext,
    beforeToolCall: ctx.harness?.beforeToolCall,
    afterToolCall: ctx.harness?.afterToolCall,
  });

  // 事件归一化转发（agent 名由上下文注入，stepId 由编排层补充）
  agent.subscribe((event) => {
    ctx.harness?.onAgentEvent?.(event, agent);
    const coreEvent = normalizeEvent(event);
    if (coreEvent) ctx.onEvent({ ...coreEvent, agent: ctx.agentName } as CoreMindEvent);
  });

  return agent;
}
