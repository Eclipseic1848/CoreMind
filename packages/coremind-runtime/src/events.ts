import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { RecoveryDisposition, ResolvedToolCapability } from "coremind-tools";
import type { LifecycleEventType, LifecycleExtensionReceiptStatus } from "./lifecycle-extension.js";
import type { LoopPhase } from "./loop-controller.js";
import type { CoreMindMessage } from "./public-message.js";
import type { ToolEffect } from "./tool-policy.js";

export type EffectReceiptStatus = "not_started" | "started" | "committed" | "unknown";

/** 工具执行证据不保存命令原文，只保留退出码、耗时与不可逆摘要。 */
export interface ToolExecutionEvidence {
  durationMs: number;
  exitCode: number | null;
  commandSha256?: string;
  testCommand?: boolean;
}

/**
 * CoreMind 归一化事件——CLI 渲染、库调用方、二期 Web 面板共用同一契约。
 * 所有事件都带 agent 名（由订阅方注入），workflow 步骤事件带 stepId。
 */
export type CoreMindEvent =
  | { type: "agent_start"; agent: string; stepId?: string; turnId?: string }
  | {
      type: "turn_end";
      agent: string;
      stepId?: string;
      /** 所属 Turn（规格 02：一次请求-响应回合的身份，可选追加字段） */
      turnId?: string;
      tokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      promptCacheStatus?: "available" | "unavailable";
      costUsd?: number;
      requestsAnotherTurn?: boolean;
    }
  | { type: "text_delta"; agent: string; delta: string; stepId?: string }
  | {
      type: "tool_call";
      agent: string;
      tool: string;
      args: unknown;
      callId?: string;
      idempotencyKey?: string;
      stepId?: string;
      turnId?: string;
    }
  | {
      type: "tool_result";
      agent: string;
      tool: string;
      isError: boolean;
      callId?: string;
      idempotencyKey?: string;
      stepId?: string;
      turnId?: string;
    }
  | {
      type: "capability_resolved";
      agent: string;
      tool: string;
      callId: string;
      stepId?: string;
      capability: ResolvedToolCapability;
      recoveryDisposition: RecoveryDisposition;
    }
  | {
      type: "effect_receipt";
      idempotencyKey: string;
      tool: string;
      status: EffectReceiptStatus;
      stepId?: string;
      turnId?: string;
    }
  | { type: "step_start"; stepId: string; kind: string }
  | {
      type: "step_output";
      stepId: string;
      agent: string;
      text: string;
      saveAs?: string;
    }
  | { type: "step_resumed"; stepId: string }
  | { type: "step_end"; stepId: string; ok: boolean }
  | {
      type: "loop_state";
      from: LoopPhase;
      to: LoopPhase;
      trigger: string;
      iteration: number;
      repairs: number;
      reason?: string;
    }
  | { type: "retry"; scope: "provider" | "workflow"; attempt: number; stepId?: string }
  | {
      type: "approval_required";
      approvalId: string;
      runId: string;
      agent: string;
      tool: string;
      args: unknown;
      risk: "low" | "high";
      effect: ToolEffect;
      capability?: ResolvedToolCapability;
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      runId: string;
      decision: "allow" | "deny";
    }
  | { type: "policy_denied"; agent: string; tool: string; reason: string }
  | {
      type: "budget_exceeded";
      dimension: "turns" | "toolCalls" | "toolFailures" | "tokens" | "costUsd";
      limit: number;
      actual: number;
      message: string;
    }
  | {
      type: "context_compacted";
      beforeTokens: number;
      afterTokens: number;
      removedMessages: number;
      strategy: "deterministic-v1";
      reason: "threshold";
      summaryFingerprint: string;
      /** 会话树压缩条目引用（落盘成功时存在）；摘要正文不落 RunState */
      sessionEntryId?: string;
    }
  | {
      type: "context_compaction_failed";
      message: string;
      preservedMessages: number;
    }
  | {
      type: "context_prefix";
      agent: string;
      fingerprint: string;
    }
  | {
      type: "artifact_created";
      artifactId: string;
      status: "stored" | "blocked";
      sizeBytes: number;
      relativePath?: string;
      sha256?: string;
      mediaType: string;
      redaction: "none" | "blocked-secret";
      tool: string;
      callId?: string;
    }
  | {
      type: "extension_lifecycle";
      extensionId: string;
      extensionVersion: string;
      lifecycle: LifecycleEventType;
      status: LifecycleExtensionReceiptStatus;
      durationMs: number;
      error?: string;
      denied?: boolean;
    }
  | {
      type: "checkpoint_created";
      checkpointId: string;
      tool: string;
      callId?: string;
      idempotencyKey?: string;
      targetPath?: string;
      reversible: boolean;
    }
  | {
      type: "tool_execution_evidence";
      agent: string;
      tool: string;
      callId: string;
      stepId?: string;
      execution: ToolExecutionEvidence;
    }
  | {
      type: "engineering_evidence";
      stepId: string;
      textPassed: boolean;
      passed: boolean;
      successfulTestCommands: number;
      regressionCommandMatched: boolean;
      checkpointRecorded: boolean;
      diffReviewed: boolean;
      reasons: string[];
    }
  | { type: "agent_end"; agent: string; stepId?: string; turnId?: string }
  | { type: "error"; message: string; fatal: boolean }
  | {
      /** 输入收据（规格 03 §4）：输入到达，尚未被任何活动消费 */
      type: "input_receipt";
      inputId: string;
      status: "pending";
      /** 输入正文的短指纹（sha256 前 16 位），不落原文 */
      contentFingerprint: string;
      timestamp: string;
    }
  | {
      /** 输入被一个 Run/Turn 认领（绑定 TurnId） */
      type: "input_claimed";
      inputId: string;
      status: "claimed";
      turnId: string;
      timestamp: string;
    }
  | {
      /** 输入对应的活动已终态完成 */
      type: "input_completed";
      inputId: string;
      status: "completed";
      timestamp: string;
    }
  | {
      /** 输入因取消/竞态被明确丢弃（如 abort 后未消费的排队输入） */
      type: "input_discarded";
      inputId: string;
      status: "discarded";
      timestamp: string;
    }
  | {
      /** 静止等待超时（不改变 Run 终态，仅记录） */
      type: "quiescence_timeout";
      timeoutMs: number;
    };

/**
 * 把上游 Agent 事件归一化为 CoreMind 事件。
 * 只保留对 UI/调用方有意义的事件；流式文本来自 message_update 的 text_delta。
 */
export function normalizeEvent(event: unknown): CoreMindEvent | null {
  if (event === null || typeof event !== "object" || !("type" in event)) return null;
  const runtimeEvent = event as AgentEvent;
  switch (runtimeEvent.type) {
    case "agent_start":
      return { type: "agent_start", agent: "" };
    case "agent_end":
      return { type: "agent_end", agent: "" };
    case "turn_end": {
      const message = runtimeEvent.message;
      const usage = message.role === "assistant" ? message.usage : undefined;
      return {
        type: "turn_end",
        agent: "",
        ...(usage
          ? {
              tokens: usage.totalTokens,
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheReadTokens: usage.cacheRead,
              cacheWriteTokens: usage.cacheWrite,
              costUsd: usage.cost.total,
            }
          : {}),
        requestsAnotherTurn:
          message.role === "assistant" && message.content.some((item) => item.type === "toolCall"),
      };
    }
    case "message_update": {
      const streamEvent = runtimeEvent.assistantMessageEvent;
      if (streamEvent?.type === "text_delta" && streamEvent.delta.length > 0) {
        return { type: "text_delta", agent: "", delta: streamEvent.delta };
      }
      return null;
    }
    case "tool_execution_start":
      return {
        type: "tool_call",
        agent: "",
        tool: runtimeEvent.toolName,
        args: runtimeEvent.args,
        callId: runtimeEvent.toolCallId,
      };
    case "tool_execution_end":
      return {
        type: "tool_result",
        agent: "",
        tool: runtimeEvent.toolName,
        isError: runtimeEvent.isError,
        callId: runtimeEvent.toolCallId,
      };
    default:
      return null;
  }
}

/** 从 Agent 消息列表提取最终文本（拼接全部 assistant 文本块） */
export function extractText(messages: CoreMindMessage[]): string {
  const runtimeMessages = messages as unknown as AgentMessage[];
  return runtimeMessages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("");
}

/** 提取最后一条 assistant 消息的执行错误；正常结束时返回 undefined。 */
export function extractAgentError(messages: CoreMindMessage[]): string | undefined {
  const runtimeMessages = messages as unknown as AgentMessage[];
  for (let index = runtimeMessages.length - 1; index >= 0; index--) {
    const message = runtimeMessages[index];
    if (message?.role !== "assistant") continue;
    return message.stopReason === "error"
      ? (message.errorMessage ?? "模型执行失败，但未提供错误详情")
      : undefined;
  }
  return undefined;
}
