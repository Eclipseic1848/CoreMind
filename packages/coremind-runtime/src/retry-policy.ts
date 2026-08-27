import { CoreMindError } from "./errors.js";
import { classifyExecutionError } from "./execution-error.js";

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

/** 只根据结构化状态分类；未知错误失败关闭，避免把业务失败误当成瞬态故障。 */
export function classifyRetry(error: unknown): RetryClassification {
  const classification = classifyExecutionError(error);
  switch (classification.retryClass) {
    case "human":
      return {
        category: "human",
        retryable: false,
        reason: `需要人工处置：${classification.code}`,
      };
    case "transient":
      return {
        category: "transient",
        retryable: true,
        reason: `瞬态错误：${classification.code}`,
      };
    case "fatal":
      return {
        category: "permanent",
        retryable: false,
        reason: `确定性错误：${classification.code}`,
      };
  }
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
