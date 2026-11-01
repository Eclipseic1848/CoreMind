import { randomUUID } from "node:crypto";
import { acceptBoundInputControl, inspectBoundRunProjection } from "./active-run-binding.js";
import type { CheckpointDiff, CheckpointRecord } from "./checkpoint.js";
import type { ControlReceipt } from "./control-inbox.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { RunProjection } from "./projection.js";
import type { CoreMindMessage } from "./public-message.js";
import type { CoreMindRuntime, RunResult } from "./runtime.js";
import { copySessionHistory } from "./session.js";
import {
  type ChatSessionNodeRef,
  type ChatSessionTree,
  navigateChatSession,
  type SessionNavigation,
} from "./session-tree.js";
import type { CoreMindTraceEvent } from "./trace.js";

/** 一轮对话的结果 */
export interface ChatTurnResult {
  /** 本轮最终文本（全部 assistant 文本拼接） */
  text: string;
  /** 本轮产生的归一化事件（含工具调用，UI 可实时渲染） */
  events: CoreMindEvent[];
  /** 本轮完整 Harness 结果，可用于预算、Trace、checkpoint 和质量 UI。 */
  run: RunResult;
}

/** 固定重试身份或预期 Run；省略时只针对调用瞬间的活动运行。 */
export interface ChatControlOptions {
  controlId?: string;
  runId?: string;
}

/**
 * 交互式会话（库 API）：多轮对话循环，供 CLI chat 与自定义 UI 复用。
 * - 每轮创建独立 Run/Agent，延续已确认的会话历史
 * - onEvent 订阅归一化事件流（工具调用实时可视化等）
 * - Runtime 在轮次收敛时持久化；persist() 只返回最近一次文件路径
 */
export class ChatSession {
  readonly agentName: string;
  private readonly listeners = new Set<
    (event: CoreMindEvent, entry?: CoreMindTraceEvent) => void
  >();
  private messages: CoreMindMessage[];
  private activeController?: AbortController;
  private latestSessionFile?: string;
  private latestRun?: RunResult;
  private navigating = false;

  constructor(
    private readonly runtime: CoreMindRuntime,
    agentName: string,
  ) {
    this.agentName = agentName;
    if (!runtime.hasAgent(agentName)) {
      throw new CoreMindError("unknown_agent", `配置中没有可用的 agent：${agentName}`);
    }
    this.messages = runtime.initialMessagesFor(agentName);
  }

  /** 订阅会话事件（返回取消函数） */
  onEvent(listener: (event: CoreMindEvent, entry?: CoreMindTraceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 发送一轮消息：返回最终文本与本轮事件 */
  async chat(message: string): Promise<ChatTurnResult> {
    if (this.activeController || this.navigating) {
      throw new CoreMindError("concurrent_run", "同一 ChatSession 不支持并发 chat()");
    }
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const run = await this.runtime.runAgentTurn(
        this.agentName,
        message,
        this.messages,
        (event, entry?: CoreMindTraceEvent) => {
          events.push(structuredClone(event));
          for (const listener of this.listeners) {
            listener(structuredClone(event), entry ? structuredClone(entry) : undefined);
          }
        },
        controller.signal,
      );
      const nextMessages = run.messages.get(this.agentName);
      if (nextMessages) {
        this.messages = copySessionHistory(nextMessages);
      }
      this.latestSessionFile = run.sessionFile;
      this.latestRun = run;
      return { text: run.transcript, events, run };
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  /** 查询持久树的快照；与写操作一样要求没有活动 Run。 */
  async inspectSessionTree(): Promise<ChatSessionTree> {
    return this.navigate({ type: "inspect" });
  }

  /** 从本会话消息节点建立命名分支；null 表示空历史，不自动切换。 */
  async createBranch(branchId: string, at: ChatSessionNodeRef | null): Promise<ChatSessionTree> {
    return this.navigate({ type: "create", branchId, at });
  }

  /** 持久选择已有分支；下一轮只从该分支构造历史。 */
  async selectBranch(branchId: string): Promise<ChatSessionTree> {
    return this.navigate({ type: "select", branchId });
  }

  /** 返回新会话的身份与树；用宿主配置重新创建 Runtime 后即可继续对话。 */
  async fork(at: ChatSessionNodeRef): Promise<ChatSessionTree> {
    return this.navigate({ type: "fork", at });
  }

  private async navigate(operation: SessionNavigation): Promise<ChatSessionTree> {
    if (this.activeController || this.navigating)
      throw new CoreMindError("concurrent_run", "活动 chat 或导航期间不能操作会话树");
    this.navigating = true;
    try {
      const result = await navigateChatSession(
        this.runtime,
        this.agentName,
        this.messages,
        operation,
      );
      if (result.history) this.messages = copySessionHistory(result.history);
      return result.tree;
    } finally {
      this.navigating = false;
    }
  }

  /** 中止当前轮 */
  abort(): void {
    this.activeController?.abort();
  }

  /** 在后续可用 Turn 追加指令；回执不代表模型已经消费。 */
  steer(message: string, options?: ChatControlOptions): Promise<ControlReceipt> {
    return acceptBoundInputControl(this.runtime, {
      type: "steering",
      message,
      controlId: options?.controlId ?? randomUUID(),
      ...(options?.runId !== undefined ? { runId: options.runId } : {}),
    });
  }

  /** 当前活动自然结束后再处理后续输入，不创建第二个 Run。 */
  followUp(message: string, options?: ChatControlOptions): Promise<ControlReceipt> {
    return acceptBoundInputControl(this.runtime, {
      type: "follow_up",
      message,
      controlId: options?.controlId ?? randomUUID(),
      ...(options?.runId !== undefined ? { runId: options.runId } : {}),
    });
  }

  /** 查询当前一轮从 canonical Facts 重建的统一 Projection。 */
  async inspectCurrentRunProjection(): Promise<RunProjection | undefined> {
    return inspectBoundRunProjection(this.runtime);
  }

  /** 返回最近一轮已完成的持久化路径；本方法不追加或刷新会话文件。 */
  async persist(): Promise<string | undefined> {
    return this.latestSessionFile;
  }

  listCheckpoints(): CheckpointRecord[] {
    return [...(this.latestRun?.checkpoints ?? [])];
  }

  async diffCheckpoint(checkpointId: string): Promise<CheckpointDiff> {
    return this.runtime.inspectCheckpoint(this.findCheckpoint(checkpointId));
  }

  async restoreCheckpoint(checkpointId: string): Promise<void> {
    return this.runtime.restoreCheckpoint(this.findCheckpoint(checkpointId));
  }

  private findCheckpoint(checkpointId: string): CheckpointRecord {
    const record = this.latestRun?.checkpoints.find((item) => item.checkpointId === checkpointId);
    if (!record) {
      throw new CoreMindError("checkpoint_not_found", `当前运行没有检查点：${checkpointId}`);
    }
    return record;
  }
}
