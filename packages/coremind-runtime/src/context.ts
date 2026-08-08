import { type AgentMessage, estimateTokens } from "@earendil-works/pi-agent-core";

export interface ContextProtectionOptions {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface ContextProtectionResult {
  messages: AgentMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  removedMessages: number;
}

/**
 * 在每次 Provider 请求前执行的本地上下文保护。
 * 摘要只在用户环境生成；保留区从 user 消息开始，避免留下孤立 toolResult。
 */
export function protectContext(
  messages: AgentMessage[],
  options: ContextProtectionOptions,
): ContextProtectionResult {
  const beforeTokens = totalEstimatedTokens(messages);
  const threshold = Math.max(1, options.contextWindow - options.reserveTokens);
  if (beforeTokens <= threshold || messages.length < 3) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      removedMessages: 0,
    };
  }

  let tailTokens = 0;
  let cutIndex = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const next = estimateTokens(messages[index]!);
    if (tailTokens > 0 && tailTokens + next > options.keepRecentTokens) break;
    tailTokens += next;
    cutIndex = index;
  }
  while (cutIndex > 0 && messages[cutIndex]?.role !== "user") cutIndex -= 1;
  if (cutIndex <= 0) {
    cutIndex = findLastUserIndex(messages);
  }
  if (cutIndex <= 0) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      removedMessages: 0,
    };
  }

  const removed = messages.slice(0, cutIndex);
  const tail = messages.slice(cutIndex);
  const maxSummaryChars = Math.max(120, options.keepRecentTokens * 2);
  const summary: AgentMessage = {
    role: "user",
    content: buildLocalSummary(removed, maxSummaryChars),
    timestamp: Date.now(),
  };
  const protectedMessages = [summary, ...tail];
  return {
    messages: protectedMessages,
    compacted: true,
    beforeTokens,
    afterTokens: totalEstimatedTokens(protectedMessages),
    removedMessages: removed.length,
  };
}

export class ContextProtector {
  constructor(
    private readonly options: ContextProtectionOptions,
    private readonly onCompacted?: (result: ContextProtectionResult) => void,
  ) {}

  transform(messages: AgentMessage[]): AgentMessage[] {
    try {
      const result = protectContext(messages, this.options);
      if (result.compacted) this.onCompacted?.(result);
      return result.messages;
    } catch {
      // 上游约定 transformContext 不得抛错；失败时保留原始上下文。
      return messages;
    }
  }
}

function totalEstimatedTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function findLastUserIndex(messages: AgentMessage[]): number {
  for (let index = messages.length - 1; index > 0; index--) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function buildLocalSummary(messages: AgentMessage[], maxChars: number): string {
  const lines = messages
    .map((message) => `${roleLabel(message)}：${messageText(message)}`)
    .filter((line) => !line.endsWith("："));
  const body = lines.join("\n");
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}…` : body;
  return `[CoreMind 上下文摘要：以下内容由本地确定性压缩生成]\n${clipped}`;
}

function roleLabel(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      return "用户";
    case "assistant":
      return "助手";
    case "toolResult":
      return `工具 ${message.toolName}`;
    default:
      return "上下文";
  }
}

function messageText(message: AgentMessage): string {
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
  }
  if (message.role === "assistant") {
    return message.content
      .map((item) => {
        if (item.type === "text") return item.text;
        if (item.type === "toolCall") return `[调用 ${item.name}]`;
        return "";
      })
      .join("");
  }
  if (message.role === "toolResult") {
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
  }
  return "";
}
