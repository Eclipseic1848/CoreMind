import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { QualityConfig } from "coremind-config";
import type { CoreMindEvent } from "./events.js";

export type RunStatus = "succeeded" | "failed" | "paused" | "aborted";

/** 运行是否以及为何结束；不与质量评分混在一起。 */
export interface RunOutcome {
  status: RunStatus;
  finishReason: string;
  error?: { code: string; message: string };
}

/** 可观测的执行成本与规模，不对业务正确性作判断。 */
export interface RunMetrics {
  durationMs: number;
  turns: number;
  steps: { total: number; succeeded: number; failed: number };
  toolCalls: number;
  toolFailures: number;
  retries: number;
  tokens?: number;
  costUsd?: number;
  outputChars: number;
}

export interface ScenarioResult {
  id: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

/** 业务评测与安全发现；没有运行评测时保持空数组，绝不伪造通过。 */
export interface EvaluationReport {
  profile: "development" | "standard" | "strict";
  scenarioResults: ScenarioResult[];
  qualityScores: Record<string, number>;
  securityFindings: string[];
}

/** 发布判断与普通运行成功分离。 */
export interface ReleaseReadiness {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  overrideRecord?: { reason: string; recordedAt: string };
}

export function analyzeRunMetrics(
  events: CoreMindEvent[],
  messages: AgentMessage[],
  durationMs: number,
  outputChars: number,
): RunMetrics {
  let turns = 0;
  let stepsTotal = 0;
  let stepsSucceeded = 0;
  let stepsFailed = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let retries = 0;
  let traceTokens = 0;
  let traceCostUsd = 0;
  let hasTraceUsage = false;

  for (const event of events) {
    switch (event.type) {
      case "turn_end":
        turns += 1;
        if (event.tokens !== undefined) {
          traceTokens += event.tokens;
          hasTraceUsage = true;
        }
        if (event.costUsd !== undefined) {
          traceCostUsd += event.costUsd;
          hasTraceUsage = true;
        }
        break;
      case "step_end":
        stepsTotal += 1;
        if (event.ok) stepsSucceeded += 1;
        else stepsFailed += 1;
        break;
      case "tool_call":
        toolCalls += 1;
        break;
      case "tool_result":
        if (event.isError) toolFailures += 1;
        break;
      case "retry":
        retries += 1;
        break;
    }
  }

  let tokens: number | undefined = hasTraceUsage ? traceTokens : undefined;
  let costUsd: number | undefined = hasTraceUsage ? traceCostUsd : undefined;
  if (!hasTraceUsage) {
    for (const message of messages) {
      if (message.role !== "assistant" || !("usage" in message) || !message.usage) continue;
      const usage = message.usage as Usage;
      tokens = (tokens ?? 0) + calculateContextTokens(usage);
      if (Number.isFinite(usage.cost?.total)) costUsd = (costUsd ?? 0) + usage.cost.total;
    }
  }

  return {
    durationMs,
    turns,
    steps: { total: stepsTotal, succeeded: stepsSucceeded, failed: stepsFailed },
    toolCalls,
    toolFailures,
    retries,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    outputChars,
  };
}

export function createEvaluationReport(
  quality: QualityConfig | undefined,
  metrics: RunMetrics,
): EvaluationReport {
  const toolReliability =
    metrics.toolCalls === 0 ? 1 : (metrics.toolCalls - metrics.toolFailures) / metrics.toolCalls;
  return {
    profile: quality?.profile ?? "standard",
    scenarioResults: [],
    qualityScores: { execution: 1, toolReliability },
    securityFindings: [],
  };
}

export function assessReleaseReadiness(
  outcome: RunOutcome,
  evaluation: EvaluationReport,
): ReleaseReadiness {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (outcome.status !== "succeeded") blockers.push(`运行状态为 ${outcome.status}`);
  if (evaluation.scenarioResults.length === 0) blockers.push("尚未执行场景评测");
  if (evaluation.securityFindings.length > 0) blockers.push("存在未解决的安全发现");
  return { ready: blockers.length === 0, blockers, warnings };
}

export function formatMetrics(metrics: RunMetrics): string {
  const parts: string[] = [];
  if (metrics.steps.total > 0) {
    parts.push(
      metrics.steps.failed > 0
        ? `${metrics.steps.succeeded}/${metrics.steps.total} 步骤成功（${metrics.steps.failed} 失败）`
        : `${metrics.steps.total} 步骤全部成功`,
    );
  }
  parts.push(
    metrics.toolFailures > 0
      ? `工具 ${metrics.toolCalls} 次调用（${metrics.toolFailures} 失败）`
      : `工具 ${metrics.toolCalls} 次调用`,
  );
  parts.push(`耗时 ${(metrics.durationMs / 1000).toFixed(1)}s`);
  if (metrics.tokens !== undefined) {
    parts.push(`约 ${metrics.tokens.toLocaleString("en-US")} tokens`);
  }
  if (metrics.costUsd !== undefined) parts.push(`$${metrics.costUsd.toFixed(4)}`);
  parts.push(`输出 ${metrics.outputChars} 字`);
  return parts.join(" · ");
}
