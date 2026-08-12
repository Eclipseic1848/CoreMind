import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  isRetryableAssistantError,
  type Usage,
} from "@earendil-works/pi-ai";

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
    dependencyFamily: "0.84.1",
    adapterVersion: 1,
    errorMappingVersion: 1,
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
  return isRetryableAssistantError(message as AssistantMessage);
}
