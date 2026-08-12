export type CoreMindMessageContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }
  | {
      type: "toolResult";
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError: boolean;
    };

/** CoreMind 公共消息合同只承诺稳定、可序列化的字段，不暴露底层运行时消息类型。 */
export interface CoreMindMessage {
  role: "user" | "assistant" | "toolResult" | string;
  content?: CoreMindMessageContent[] | string;
  timestamp?: number;
  stopReason?: string;
  errorMessage?: string;
}
