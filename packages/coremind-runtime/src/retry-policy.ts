import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";
import { CoreMindError } from "./errors.js";

export type RetryCategory = "transient" | "permanent" | "human";

export interface RetryClassification {
  category: RetryCategory;
  retryable: boolean;
  reason: string;
}

export interface TransientRetryOptions {
  maxRetries: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: unknown) => void;
}

const HUMAN_CODES = new Set([
  "approval_denied",
  "tool_approval_denied",
  "policy_denied",
  "unknown_effect",
  "committed_effect_pending",
  "loop_paused",
]);
const TRANSIENT_CODES = new Set([
  "network_error",
  "provider_unavailable",
  "provider_timeout",
  "provider_transient",
  "rate_limit",
]);
const TRANSIENT_SYSTEM_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);

/** 只根据结构化状态分类；未知错误失败关闭，避免把业务失败误当成瞬态故障。 */
export function classifyRetry(error: unknown): RetryClassification {
  const values = errorChain(error);
  for (const value of values) {
    const code = stringField(value, "code");
    if (code && HUMAN_CODES.has(code)) {
      return { category: "human", retryable: false, reason: `需要人工处置：${code}` };
    }
  }
  for (const value of values) {
    if (isAssistantFailure(value)) {
      return isRetryableAssistantError(value as AssistantMessage)
        ? { category: "transient", retryable: true, reason: "模型适配层判定为瞬态错误" }
        : { category: "permanent", retryable: false, reason: "模型适配层判定为确定性错误" };
    }
  }
  for (const value of values) {
    const code = stringField(value, "code");
    if (code && TRANSIENT_CODES.has(code)) {
      return { category: "transient", retryable: true, reason: `瞬态错误：${code}` };
    }
    if (code && TRANSIENT_SYSTEM_CODES.has(code)) {
      return { category: "transient", retryable: true, reason: `网络错误：${code}` };
    }
    const status = numericField(value, "status") ?? numericField(value, "statusCode");
    if (
      status === 408 ||
      status === 429 ||
      (status !== undefined && status >= 500 && status <= 599)
    ) {
      return { category: "transient", retryable: true, reason: `HTTP ${status}` };
    }
  }
  return { category: "permanent", retryable: false, reason: "未识别为可安全重试的瞬态错误" };
}

function isAssistantFailure(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).role === "assistant" &&
    (value as Record<string, unknown>).stopReason === "error" &&
    typeof (value as Record<string, unknown>).errorMessage === "string"
  );
}

/** 执行有界重试；只有明确分类为 transient 的失败才能进入下一次尝试。 */
export async function runWithTransientRetry<T>(
  operation: () => Promise<T>,
  options: TransientRetryOptions,
): Promise<T> {
  const maxRetries = Math.max(0, Math.trunc(options.maxRetries));
  for (let attempt = 0; ; attempt++) {
    assertNotAborted(options.signal);
    try {
      return await operation();
    } catch (error) {
      const classification = classifyRetry(error);
      if (!classification.retryable || attempt >= maxRetries) throw error;
      assertNotAborted(options.signal);
      options.onRetry?.(attempt + 1, error);
    }
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CoreMindError("aborted", "执行已中止");
}

function errorChain(error: unknown): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    values.push(current);
    seen.add(current);
    current = objectField(current, "cause");
  }
  return values;
}

function objectField(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectField(value, key);
  return typeof field === "string" ? field : undefined;
}

function numericField(value: unknown, key: string): number | undefined {
  const field = objectField(value, key);
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}
