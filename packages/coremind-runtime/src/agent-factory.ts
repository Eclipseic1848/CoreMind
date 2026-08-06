import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
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
}

/**
 * 把 agent 配置构建为可运行的 Agent 实例。
 * 关键点：显式绑定 models.streamSimple 为 streamFn，自定义 baseUrl/headers 才能生效。
 */
export function buildAgent(agentCfg: AgentConfig, ctx: AgentBuildContext): Agent {
  const agent = new Agent({
    initialState: {
      systemPrompt: agentCfg.systemPrompt,
      model: ctx.model,
      tools: ctx.tools,
      messages: ctx.sessionMessages ?? [],
      thinkingLevel: agentCfg.options?.thinkingLevel,
    },
    streamFn: (m, c, o) => ctx.models.streamSimple(m, c, o),
    toolExecution: "parallel",
  });

  // 事件归一化转发（agent 名由上下文注入，stepId 由编排层补充）
  agent.subscribe((event) => {
    const coreEvent = normalizeEvent(event);
    if (coreEvent) ctx.onEvent({ ...coreEvent, agent: ctx.agentName } as CoreMindEvent);
  });

  return agent;
}
