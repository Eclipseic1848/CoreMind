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

export interface ContextProtectionFailure {
  message: string;
  preservedMessages: number;
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
  const maxSummaryChars = Math.max(480, options.keepRecentTokens * 2);
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
    private readonly onFailed?: (failure: ContextProtectionFailure) => void,
  ) {}

  transform(messages: AgentMessage[]): AgentMessage[] {
    try {
      const result = protectContext(messages, this.options);
      if (result.compacted) this.onCompacted?.(result);
      return result.messages;
    } catch (error) {
      // 上游约定 transformContext 不得抛错；失败时保留原始上下文。
      this.onFailed?.({
        message: `上下文压缩失败：${error instanceof Error ? error.message : String(error)}`,
        preservedMessages: messages.length,
      });
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
  const entries = messages
    .map((message) => ({ role: roleLabel(message), text: messageText(message).trim() }))
    .filter((entry) => entry.text.length > 0);
  const texts = entries.map((entry) => entry.text);
  const target = findFirst(texts, /(?:目标|任务|请|需要|goal|task)/i) ?? entries[0]?.text;
  const constraints = findAll(
    texts,
    /(?:必须|不得|不要|只能|约束|限制|must|never|only|constraint)/i,
  );
  const permissions = findAll(
    texts,
    /(?:权限|批准|审批|允许|拒绝|permission|approval|allow|deny)/i,
  );
  const modifiedFiles = findAll(
    texts,
    /(?:修改|写入|保存|创建|删除|文件|\.ts\b|\.tsx\b|\.js\b|\.py\b|\.md\b|modified|wrote|file)/i,
  );
  const tests = findAll(texts, /(?:测试|门禁|通过|失败|检查|test|pass|fail|check)/i);
  const nextStep = findLast(texts, /(?:下一步|接下来|继续|next)/i) ?? entries.at(-1)?.text;
  const sections = [
    `目标：${clip(target ?? "未记录", 120)}`,
    `约束：${clip(constraints || "未记录", 120)}`,
    `权限：${clip(permissions || "未记录", 100)}`,
    `已修改文件：${clip(modifiedFiles || "未记录", 120)}`,
    `测试状态：${clip(tests || "未记录", 100)}`,
    `下一步：${clip(nextStep ?? "未记录", 120)}`,
  ];
  const prefix = `[CoreMind 上下文摘要：以下内容由本地确定性压缩生成]\n${sections.join("\n")}`;
  const history = entries.map((entry) => `${entry.role}：${entry.text}`).join("\n");
  const remaining = Math.max(0, maxChars - prefix.length - 8);
  return remaining > 0 && history.length > 0
    ? `${prefix}\n历史：${clip(history, remaining)}`
    : prefix;
}

function findFirst(texts: string[], pattern: RegExp): string | undefined {
  return texts.find((text) => pattern.test(text));
}

function findLast(texts: string[], pattern: RegExp): string | undefined {
  return [...texts].reverse().find((text) => pattern.test(text));
}

function findAll(texts: string[], pattern: RegExp): string {
  return texts
    .filter((text) => pattern.test(text))
    .slice(-3)
    .join("；");
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
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
