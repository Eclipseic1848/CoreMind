import {
  type AssistantMessage,
  isRetryableAssistantError,
  type Usage,
} from "@earendil-works/pi-ai";
import { calculateContextTokens } from "./session-v4/index.js";

/** CoreMind 对低层运行依赖的唯一能力说明；调用方无需理解依赖包结构。 */
export interface RuntimeCompatibilityReport {
  dependencyFamily: string;
  adapterVersion: number;
  errorMappingVersion: number;
  capabilities: {
    streaming: boolean;
    toolCalls: boolean;
    abort: boolean;
    usage: boolean;
    errors: boolean;
    timeouts: boolean;
  };
}

export interface NormalizedDependencyUsage {
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
}

export function inspectRuntimeCompatibility(): RuntimeCompatibilityReport {
  return {
    dependencyFamily: "1.3.0",
    adapterVersion: 2,
    errorMappingVersion: 2,
    capabilities: {
      streaming: true,
      toolCalls: true,
      abort: true,
      usage: true,
      errors: true,
      timeouts: true,
    },
  };
}

/** 把低层 Usage 转为 CoreMind 稳定计量结构。 */
export function normalizeDependencyUsage(usage: Usage): NormalizedDependencyUsage {
  return {
    totalTokens: usage.totalTokens,
    contextTokens: calculateContextTokens(usage),
    costUsd: Number.isFinite(usage.cost?.total) ? usage.cost.total : 0,
  };
}

/** 错误分类只在 Adapter 内依赖低层消息结构。 */
export function isRetryableDependencyAssistantError(message: unknown): boolean {
  const assistant = message as AssistantMessage;
  if (!assistant.errorMessage) return isRetryableAssistantError(assistant);
  return isRetryableAssistantError({
    ...assistant,
    // shortcut: Pi 1.3.0 缺状态码边界；官方安全版升级后可移除此兼容处理，保留回归。
    errorMessage: assistant.errorMessage.replace(
      /429|500|502|503|504|520|524/g,
      (status, offset: number, source: string) => {
        const neighbors = (source[offset - 1] ?? "") + (source[offset + status.length] ?? "");
        // 等长字母保留原边界，避免删除数字后拼出新的瞬态关键词。
        return /[a-z0-9]/i.test(neighbors) ? "xxx" : status;
      },
    ),
  });
}
