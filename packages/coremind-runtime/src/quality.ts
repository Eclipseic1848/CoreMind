import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { CoreMindEvent } from "./events.js";

/** 一次运行的质量摘要（机制兜底闭环：跑完知道好不好） */
export interface RunQuality {
  /** 步骤统计 */
  steps: { total: number; ok: number; failed: number };
  /** 工具调用统计 */
  tools: { total: number; failed: number };
  /** 运行耗时 ms */
  elapsedMs: number;
  /** token 消耗（来自上游 assistant usage 汇总；无 usage 时为 undefined） */
  tokens?: number;
  /** 主输出长度（字符） */
  outputChars: number;
}

/**
 * 从事件序列与消息汇总运行质量。
 * token 统计复用上游 calculateContextTokens（assistant 消息自带 usage，不自行估算）。
 */
export function analyzeRun(
  events: CoreMindEvent[],
  messages: AgentMessage[],
  elapsedMs: number,
  outputChars: number,
): RunQuality {
  let stepsTotal = 0;
  let stepsOk = 0;
  let stepsFailed = 0;
  let toolsTotal = 0;
  let toolsFailed = 0;

  for (const event of events) {
    if (event.type === "step_end") {
      stepsTotal += 1;
      if (event.ok) stepsOk += 1;
      else stepsFailed += 1;
    } else if (event.type === "tool_call") {
      toolsTotal += 1;
    } else if (event.type === "tool_result" && event.isError) {
      toolsFailed += 1;
    }
  }

  let tokens: number | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && "usage" in message && message.usage) {
      const used = calculateContextTokens(message.usage as Usage);
      tokens = (tokens ?? 0) + used;
    }
  }

  return {
    steps: { total: stepsTotal, ok: stepsOk, failed: stepsFailed },
    tools: { total: toolsTotal, failed: toolsFailed },
    elapsedMs,
    ...(tokens !== undefined ? { tokens } : {}),
    outputChars,
  };
}

/** 摘要文本（CLI 打印用） */
export function formatQuality(q: RunQuality): string {
  const parts: string[] = [];
  if (q.steps.total > 0) {
    parts.push(
      q.steps.failed > 0
        ? `${q.steps.ok}/${q.steps.total} 步骤成功（${q.steps.failed} 失败）`
        : `${q.steps.total} 步骤全部成功`,
    );
  }
  parts.push(
    q.tools.failed > 0
      ? `工具 ${q.tools.total} 次调用（${q.tools.failed} 失败）`
      : `工具 ${q.tools.total} 次调用`,
  );
  parts.push(`耗时 ${(q.elapsedMs / 1000).toFixed(1)}s`);
  if (q.tokens !== undefined) parts.push(`约 ${q.tokens.toLocaleString("en-US")} tokens`);
  parts.push(`输出 ${q.outputChars} 字`);
  return parts.join(" · ");
}
