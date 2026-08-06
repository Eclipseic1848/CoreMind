import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * CoreMind 归一化事件——CLI 渲染、库调用方、二期 Web 面板共用同一契约。
 * 所有事件都带 agent 名（由订阅方注入），workflow 步骤事件带 stepId。
 */
export type CoreMindEvent =
  | { type: "agent_start"; agent: string; stepId?: string }
  | { type: "text_delta"; agent: string; delta: string; stepId?: string }
  | { type: "tool_call"; agent: string; tool: string; args: unknown; stepId?: string }
  | { type: "tool_result"; agent: string; tool: string; isError: boolean; stepId?: string }
  | { type: "step_start"; stepId: string; kind: string }
  | { type: "step_end"; stepId: string; ok: boolean }
  | { type: "agent_end"; agent: string; stepId?: string }
  | { type: "error"; message: string; fatal: boolean };

/**
 * 把上游 Agent 事件归一化为 CoreMind 事件。
 * 只保留对 UI/调用方有意义的事件；流式文本来自 message_update 的 text_delta。
 */
export function normalizeEvent(event: AgentEvent): CoreMindEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent_start", agent: "" };
    case "agent_end":
      return { type: "agent_end", agent: "" };
    case "message_update": {
      const streamEvent = event.assistantMessageEvent;
      if (streamEvent?.type === "text_delta" && streamEvent.delta.length > 0) {
        return { type: "text_delta", agent: "", delta: streamEvent.delta };
      }
      return null;
    }
    case "tool_execution_start":
      return { type: "tool_call", agent: "", tool: event.toolName, args: event.args };
    case "tool_execution_end":
      return { type: "tool_result", agent: "", tool: event.toolName, isError: event.isError };
    default:
      return null;
  }
}

/** 从 Agent 消息列表提取最终文本（拼接全部 assistant 文本块） */
export function extractText(messages: AgentMessage[]): string {
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}
