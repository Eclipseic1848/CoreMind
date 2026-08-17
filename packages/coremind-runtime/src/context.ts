import { createHash } from "node:crypto";
import { type AgentMessage, estimateTokens } from "@earendil-works/pi-agent-core";
import type { CoreMindMessage } from "./public-message.js";

export interface ContextProtectionOptions {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
}

export interface ContextProtectionResult {
  messages: CoreMindMessage[];
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  removedMessages: number;
  strategy: "none" | "deterministic-v1";
  reason?: "threshold";
  summaryFingerprint?: string;
  /** 被摘要替换的输入消息范围 [start, end)（仅压缩时存在，供会话树落盘桥接） */
  replacedRange?: { start: number; end: number };
}

export interface StableContextPrefixInput {
  projectInstructions: string;
  tools: Array<{ name: string; description: string }>;
  stableFacts?: Record<string, string | number | boolean>;
  skillsContent?: string[];
}

export interface StableContextPrefix {
  text: string;
  fingerprint: string;
}

export interface ContextStrategyComparison {
  selected: "deterministic-v1";
  variants: Array<{
    strategy: "none" | "deterministic-v1" | "deterministic-v1-more-recent";
    tokens: number;
    messages: number;
  }>;
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
  messages: CoreMindMessage[],
  options: ContextProtectionOptions,
): ContextProtectionResult {
  const runtimeMessages = messages as unknown as AgentMessage[];
  const beforeTokens = totalEstimatedTokens(runtimeMessages);
  const threshold = Math.max(1, options.contextWindow - options.reserveTokens);
  if (beforeTokens <= threshold || messages.length < 3) {
    return {
      messages,
      compacted: false,
      beforeTokens,
      afterTokens: beforeTokens,
      removedMessages: 0,
      strategy: "none",
    };
  }

  let tailTokens = 0;
  let cutIndex = messages.length - 1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const next = estimateTokens(runtimeMessages[index]!);
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
      strategy: "none",
    };
  }

  const removed = messages.slice(0, cutIndex);
  const tail = messages.slice(cutIndex);
  const maxSummaryChars = Math.max(480, options.keepRecentTokens * 2);
  const summaryText = buildLocalSummary(removed as unknown as AgentMessage[], maxSummaryChars);
  const summary: CoreMindMessage = {
    role: "user",
    content: summaryText,
    timestamp: Date.now(),
  };
  const protectedMessages = [summary, ...tail];
  return {
    messages: protectedMessages,
    compacted: true,
    beforeTokens,
    afterTokens: totalEstimatedTokens(protectedMessages as unknown as AgentMessage[]),
    removedMessages: removed.length,
    strategy: "deterministic-v1",
    reason: "threshold",
    summaryFingerprint: fingerprint(summaryText),
    replacedRange: { start: 0, end: cutIndex },
  };
}

/** 固定分区和排序规则，保证同一静态输入生成逐字节一致的 Provider 前缀。 */
export function buildStableContextPrefix(input: StableContextPrefixInput): StableContextPrefix {
  const tools = [...input.tools]
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");
  const facts = Object.entries(input.stableFacts ?? {})
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) => `- ${key}: ${String(value)}`)
    .join("\n");
  const skills = (input.skillsContent ?? [])
    .map((content, index) => `### Skill ${index + 1}\n${content}`)
    .join("\n\n");
  const text = [
    "# CoreMind 稳定上下文 v1",
    "## 核心规则\n遵循配置、权限、预算、质量门禁和可恢复运行契约；不得虚构工具结果。",
    `## 项目指令\n${input.projectInstructions.trim()}`,
    `## 工具契约\n${tools || "- 无"}`,
    `## 稳定事实\n${facts || "- 无"}`,
    `## 专业技能\n${skills || "- 无"}`,
  ].join("\n\n");
  return { text, fingerprint: fingerprint(text) };
}

/** 只输出离线策略对照，不改变运行时默认策略。 */
export function compareContextStrategies(
  messages: CoreMindMessage[],
  options: ContextProtectionOptions,
): ContextStrategyComparison {
  const current = protectContext(messages, options);
  const moreRecent = protectContext(messages, {
    ...options,
    keepRecentTokens: Math.max(
      options.keepRecentTokens,
      Math.floor(options.keepRecentTokens * 1.5),
    ),
  });
  return {
    selected: "deterministic-v1",
    variants: [
      {
        strategy: "none",
        tokens: totalEstimatedTokens(messages as unknown as AgentMessage[]),
        messages: messages.length,
      },
      {
        strategy: "deterministic-v1",
        tokens: current.afterTokens,
        messages: current.messages.length,
      },
      {
        strategy: "deterministic-v1-more-recent",
        tokens: moreRecent.afterTokens,
        messages: moreRecent.messages.length,
      },
    ],
  };
}

export class ContextProtector {
  constructor(
    private readonly options: ContextProtectionOptions,
    private readonly onCompacted?: (result: ContextProtectionResult) => void | Promise<void>,
    private readonly onFailed?: (failure: ContextProtectionFailure) => void,
  ) {}

  /** 同步压缩（0.3.0 兼容入口）：异步压缩回调必须改用 transformAsync，避免落盘竞态。 */
  transform(messages: CoreMindMessage[]): CoreMindMessage[] {
    try {
      const result = protectContext(messages, this.options);
      if (result.compacted) {
        const pending = this.onCompacted?.(result);
        if (pending instanceof Promise) {
          throw new Error("异步压缩回调必须使用 transformAsync，不能用同步 transform");
        }
      }
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

  /** 异步压缩：回调允许会话树落盘；回调失败时保留原文并走失败路径。 */
  async transformAsync(messages: CoreMindMessage[]): Promise<CoreMindMessage[]> {
    try {
      const result = protectContext(messages, this.options);
      if (result.compacted) await this.onCompacted?.(result);
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

function findLastUserIndex(messages: CoreMindMessage[]): number {
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
  const incompleteTasks = findAll(
    texts,
    /(?:未完成|待办|剩余|阻塞|暂停|继续|incomplete|todo|remaining|blocked|paused)/i,
  );
  const uncertainEffects = findAll(
    texts,
    /(?:不确定|未知|可能|需确认|副作用|uncertain|unknown|possible|side effect)/i,
  );
  const nextStep = findLast(texts, /(?:下一步|接下来|继续|next)/i) ?? entries.at(-1)?.text;
  const sections = [
    `目标：${clip(target ?? "未记录", 120)}`,
    `约束：${clip(constraints || "未记录", 120)}`,
    `权限：${clip(permissions || "未记录", 100)}`,
    `已修改文件：${clip(modifiedFiles || "未记录", 120)}`,
    `测试状态：${clip(tests || "未记录", 100)}`,
    `未完成任务：${clip(incompleteTasks || "未记录", 100)}`,
    `不确定副作用：${clip(uncertainEffects || "未记录", 100)}`,
    `下一步：${clip(nextStep ?? "未记录", 120)}`,
  ];
  const prefix = `[CoreMind 上下文摘要：以下内容由本地确定性压缩生成]\n${sections.join("\n")}`;
  const history = entries.map((entry) => `${entry.role}：${entry.text}`).join("\n");
  const remaining = Math.max(0, maxChars - prefix.length - 8);
  return remaining > 0 && history.length > 0
    ? `${prefix}\n历史：${clip(history, remaining)}`
    : prefix;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
