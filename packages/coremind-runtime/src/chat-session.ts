import type { Agent } from "@earendil-works/pi-agent-core";
import { CoreMindError } from "./errors.js";
import { type CoreMindEvent, extractText, normalizeEvent } from "./events.js";
import type { CoreMindRuntime } from "./runtime.js";

/** 一轮对话的结果 */
export interface ChatTurnResult {
  /** 本轮最终文本（全部 assistant 文本拼接） */
  text: string;
  /** 本轮产生的归一化事件（含工具调用，UI 可实时渲染） */
  events: CoreMindEvent[];
}

/**
 * 交互式会话（库 API）：多轮对话循环，供 CLI chat 与自定义 UI 复用。
 * - 同一 agent 实例持续对话（上下文延续）
 * - onEvent 订阅归一化事件流（工具调用实时可视化等）
 * - persist() 接入运行时会话持久化（需 session.enabled + sessionId）
 */
export class ChatSession {
  readonly agentName: string;
  private readonly agent: Agent;
  private readonly listeners = new Set<(event: CoreMindEvent) => void>();

  constructor(
    private readonly runtime: CoreMindRuntime,
    agentName: string,
  ) {
    this.agentName = agentName;
    const agent = runtime.createAgent(agentName);
    if (!agent) {
      throw new CoreMindError("unknown_agent", `配置中没有可用的 agent：${agentName}`);
    }
    this.agent = agent;
    // 订阅本 agent 的归一化事件（与 agent-factory 的转发独立，UI 直接消费）
    this.agent.subscribe((event) => {
      const core = normalizeEvent(event);
      if (!core) return;
      // 与 agent-factory 相同：注入 agent 名（联合类型展开需断言）
      const ce = { ...core, agent: agentName } as CoreMindEvent;
      for (const listener of this.listeners) listener(ce);
    });
  }

  /** 订阅会话事件（返回取消函数） */
  onEvent(listener: (event: CoreMindEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 发送一轮消息：返回最终文本与本轮事件 */
  async chat(message: string): Promise<ChatTurnResult> {
    const events: CoreMindEvent[] = [];
    const collect = (e: CoreMindEvent) => events.push(e);
    this.listeners.add(collect);
    try {
      await this.agent.prompt(message);
      await this.agent.waitForIdle();
      return { text: extractText(this.agent.state.messages), events };
    } finally {
      this.listeners.delete(collect);
    }
  }

  /** 中止当前轮 */
  abort(): void {
    this.agent.abort();
  }

  /** 持久化会话（需 config.session.enabled 与 runtime sessionId；返回文件路径） */
  persist(): Promise<string | undefined> {
    return this.runtime.persistSession();
  }
}
