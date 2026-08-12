import type { CheckpointDiff, CheckpointRecord } from "./checkpoint.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { CoreMindMessage } from "./public-message.js";
import type { CoreMindRuntime, RunResult } from "./runtime.js";

/** 一轮对话的结果 */
export interface ChatTurnResult {
  /** 本轮最终文本（全部 assistant 文本拼接） */
  text: string;
  /** 本轮产生的归一化事件（含工具调用，UI 可实时渲染） */
  events: CoreMindEvent[];
  /** 本轮完整 Harness 结果，可用于预算、Trace、checkpoint 和质量 UI。 */
  run: RunResult;
}

/**
 * 交互式会话（库 API）：多轮对话循环，供 CLI chat 与自定义 UI 复用。
 * - 同一 agent 实例持续对话（上下文延续）
 * - onEvent 订阅归一化事件流（工具调用实时可视化等）
 * - persist() 接入运行时会话持久化（需 session.enabled + sessionId）
 */
export class ChatSession {
  readonly agentName: string;
  private readonly listeners = new Set<(event: CoreMindEvent) => void>();
  private messages: CoreMindMessage[];
  private activeController?: AbortController;
  private latestSessionFile?: string;
  private latestRun?: RunResult;

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
  onEvent(listener: (event: CoreMindEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 发送一轮消息：返回最终文本与本轮事件 */
  async chat(message: string): Promise<ChatTurnResult> {
    const events: CoreMindEvent[] = [];
    const controller = new AbortController();
    this.activeController = controller;
    try {
      const run = await this.runtime.runAgentTurn(
        this.agentName,
        message,
        this.messages,
        (event) => {
          events.push(event);
          for (const listener of this.listeners) listener(event);
        },
        controller.signal,
      );
      const nextMessages = run.messages.get(this.agentName);
      if (nextMessages) {
        this.messages = [...nextMessages];
      }
      this.latestSessionFile = run.sessionFile;
      this.latestRun = run;
      return { text: run.transcript, events, run };
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  /** 中止当前轮 */
  abort(): void {
    this.activeController?.abort();
  }

  /** 持久化会话（需 config.session.enabled 与 runtime sessionId；返回文件路径） */
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
