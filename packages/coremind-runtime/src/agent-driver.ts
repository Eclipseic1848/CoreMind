import type { CoreMindMessage, CoreMindMessageContent } from "./public-message.js";

export interface AgentDriverStatus {
  running: boolean;
  pendingToolCalls: number;
  queuedControls: number;
}

export type AgentDriverObservation =
  | { type: "agent_start" }
  | { type: "agent_end" }
  | { type: "text_delta"; delta: string }
  | { type: "turn_end"; message: CoreMindMessage }
  | { type: "tool_execution_start"; call: AgentDriverToolCall }
  | {
      type: "tool_execution_end";
      call: AgentDriverToolCall;
      result: AgentDriverToolResult;
      isError: boolean;
    };

export interface AgentDriverToolCall {
  callId: string;
  tool: string;
  args: unknown;
}

export interface AgentDriverToolResult {
  content: CoreMindMessageContent[];
  details: unknown;
}

export interface AgentDriverContextContract {
  stablePrefix: string;
  toolSchemas: unknown[];
}

export interface AgentDriverBeforeToolCallContext {
  toolCall: AgentDriverToolCall;
}

export interface AgentDriverAfterToolCallContext extends AgentDriverBeforeToolCallContext {
  result: AgentDriverToolResult;
  isError: boolean;
}

export interface AgentDriverBeforeToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface AgentDriverAfterToolCallResult {
  content?: CoreMindMessageContent[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

export interface AgentDriverToolExecutionRequest {
  call: AgentDriverToolCall;
  signal?: AbortSignal;
  invoke(): Promise<AgentDriverToolResult>;
}

export interface AgentDriverTurnObservation {
  type: "turn_end";
  message: CoreMindMessage;
  totalTokens: number;
  contextTokens: number;
  costUsd: number;
  requestsAnotherTurn: boolean;
  contextOverflow: boolean;
}

/** Runtime 注入的 Harness 只使用 CoreMind 类型；P3 类型在 Adapter 内终止。 */
export interface AgentDriverHarness {
  maxRetries?: number;
  registerContextContract?: (contract: AgentDriverContextContract) => void;
  beforeModelRequest?: () => void;
  onModelRequestDispatched?: (request: {
    providerId: string;
    modelId: string;
    messages: readonly unknown[];
  }) => void;
  transformContext?: (
    messages: CoreMindMessage[],
    signal?: AbortSignal,
  ) => Promise<CoreMindMessage[]>;
  beforeToolCall?: (
    context: AgentDriverBeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AgentDriverBeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AgentDriverAfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AgentDriverAfterToolCallResult | undefined>;
  executeTool?: (request: AgentDriverToolExecutionRequest) => Promise<AgentDriverToolResult>;
  onObservation?: (observation: AgentDriverObservation | AgentDriverTurnObservation) => void;
  shouldStopAfterTurn?: () => boolean | Promise<boolean>;
  throwIfDenied?: () => void;
  throwIfContextFailed?: () => void;
}

export interface AgentDriverControl {
  type: "steering" | "follow_up";
  message: string;
}

/** 底层模型循环只能通过此接口向 CoreMind 暴露可观测行为。 */
export interface AgentDriver {
  prompt(input: string): Promise<void>;
  waitForIdle(): Promise<void>;
  messages(): CoreMindMessage[];
  status(): AgentDriverStatus;
  abort(): void;
  queueControl(control: AgentDriverControl): void;
}

export type FakeAgentDriverStep =
  | { type: "text_delta"; delta: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_batch"; calls: readonly AgentDriverToolCall[] };

export interface FakeAgentDriverOptions {
  script: readonly FakeAgentDriverStep[];
  executeTool?: (call: AgentDriverToolCall, signal: AbortSignal) => Promise<AgentDriverToolResult>;
  onObservation?: (observation: AgentDriverObservation) => void;
}

/** 确定性 Fake Adapter；测试和生产 Adapter 共享同一个 AgentDriver 接口。 */
export class FakeAgentDriver implements AgentDriver {
  private readonly transcript: CoreMindMessage[] = [];
  private running = false;
  private pendingToolCalls = 0;
  private active: Promise<void> = Promise.resolve();
  private activeController?: AbortController;
  private readonly steeringQueue: string[] = [];
  private readonly followUpQueue: string[] = [];

  constructor(private readonly options: FakeAgentDriverOptions) {}

  async prompt(input: string): Promise<void> {
    if (this.running) throw new Error("AgentDriver 已在运行");
    this.running = true;
    this.activeController = new AbortController();
    this.transcript.push({ role: "user", content: input, timestamp: 0 });
    this.options.onObservation?.({ type: "agent_start" });
    this.active = this.runScript();
    return this.active;
  }

  waitForIdle(): Promise<void> {
    return this.active;
  }

  messages(): CoreMindMessage[] {
    return [...this.transcript];
  }

  status(): AgentDriverStatus {
    return {
      running: this.running,
      pendingToolCalls: this.pendingToolCalls,
      queuedControls: this.steeringQueue.length + this.followUpQueue.length,
    };
  }

  abort(): void {
    this.activeController?.abort();
    this.steeringQueue.length = 0;
    this.followUpQueue.length = 0;
  }

  queueControl(control: AgentDriverControl): void {
    const queue = control.type === "steering" ? this.steeringQueue : this.followUpQueue;
    queue.push(control.message);
  }

  private async runScript(): Promise<void> {
    try {
      for (const step of this.options.script) {
        if (this.activeController?.signal.aborted) break;
        if (step.type === "text_delta") {
          this.options.onObservation?.(step);
          continue;
        }
        if (step.type === "tool_batch") {
          await this.executeToolBatch(step.calls);
          continue;
        }
        const message: CoreMindMessage = {
          role: "assistant",
          content: [{ type: "text", text: step.text }],
          stopReason: "stop",
          timestamp: 1,
        };
        this.transcript.push(message);
        this.options.onObservation?.({ type: "turn_end", message });
        this.drainControls(this.steeringQueue);
      }
      this.drainControls(this.steeringQueue);
      this.drainControls(this.followUpQueue);
      if (this.activeController?.signal.aborted) {
        const message: CoreMindMessage = {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          timestamp: 1,
        };
        this.transcript.push(message);
        this.options.onObservation?.({ type: "turn_end", message });
      }
    } finally {
      this.running = false;
      this.options.onObservation?.({ type: "agent_end" });
    }
  }

  private async executeToolBatch(calls: readonly AgentDriverToolCall[]): Promise<void> {
    if (!this.options.executeTool) throw new Error("Fake AgentDriver 缺少工具执行回调");
    const signal = this.activeController?.signal;
    if (!signal) throw new Error("Fake AgentDriver 没有活动的取消信号");
    this.pendingToolCalls += calls.length;
    for (const call of calls) {
      this.options.onObservation?.({ type: "tool_execution_start", call });
    }
    await Promise.all(
      calls.map(async (call) => {
        try {
          const result = await this.options.executeTool!(call, signal);
          if (signal.aborted) return;
          this.options.onObservation?.({
            type: "tool_execution_end",
            call,
            result,
            isError: false,
          });
        } catch (error) {
          if (signal.aborted) return;
          this.options.onObservation?.({
            type: "tool_execution_end",
            call,
            result: {
              content: [
                { type: "text", text: error instanceof Error ? error.message : String(error) },
              ],
              details: {},
            },
            isError: true,
          });
        } finally {
          this.pendingToolCalls -= 1;
        }
      }),
    );
  }

  private drainControls(queue: string[]): void {
    while (queue.length > 0) {
      this.transcript.push({ role: "user", content: queue.shift()!, timestamp: 2 });
    }
  }
}
