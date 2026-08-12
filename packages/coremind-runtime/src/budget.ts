import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { RuntimeLimitsConfig } from "coremind-config";
import { normalizeDependencyUsage } from "./dependency-adapter.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";

export interface ResolvedRuntimeLimits {
  maxTurns: number;
  maxSteps: number;
  stepTimeoutMs: number;
  runTimeoutMs: number;
  maxToolCalls: number;
  maxToolFailures: number;
  maxRetries: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface BudgetViolation {
  dimension: "turns" | "toolCalls" | "toolFailures" | "tokens" | "costUsd";
  limit: number;
  actual: number;
  message: string;
}

const DEFAULT_LIMITS: ResolvedRuntimeLimits = {
  maxTurns: 20,
  maxSteps: 100,
  stepTimeoutMs: 300_000,
  runTimeoutMs: 900_000,
  maxToolCalls: 50,
  maxToolFailures: 3,
  maxRetries: 3,
};

export function resolveRuntimeLimits(
  config: RuntimeLimitsConfig | undefined,
  overrides:
    | Pick<ResolvedRuntimeLimits, "maxSteps" | "stepTimeoutMs">
    | Partial<ResolvedRuntimeLimits>,
): ResolvedRuntimeLimits {
  return { ...DEFAULT_LIMITS, ...config, ...withoutUndefined(overrides) };
}

/** 一次 Run 独占的多维预算计数器。 */
export class RunBudgetController {
  private turns = 0;
  private toolCalls = 0;
  private toolFailures = 0;
  private tokens = 0;
  private costUsd = 0;
  violation?: BudgetViolation;

  constructor(
    readonly limits: ResolvedRuntimeLimits,
    private readonly emit: (event: CoreMindEvent) => void,
  ) {}

  /** 恢复运行时重放既有 Trace 的计数，不重复发出事件或副作用。 */
  restore(event: CoreMindEvent): void {
    if (event.type === "tool_call") this.toolCalls += 1;
    if (event.type === "tool_result" && event.isError) this.toolFailures += 1;
    if (event.type === "turn_end") {
      this.turns += 1;
      this.tokens += event.tokens ?? 0;
      this.costUsd += event.costUsd ?? 0;
    }
  }

  beforeToolCall(): { block: true; reason: string } | undefined {
    this.toolCalls += 1;
    if (this.toolCalls > this.limits.maxToolCalls) {
      return this.fail(
        "toolCalls",
        this.limits.maxToolCalls,
        this.toolCalls,
        `工具调用次数超过上限（${this.limits.maxToolCalls} 次）`,
      );
    }
    return undefined;
  }

  afterToolCall(isError: boolean): { terminate: true } | undefined {
    if (isError) this.toolFailures += 1;
    if (this.toolFailures > this.limits.maxToolFailures) {
      this.fail(
        "toolFailures",
        this.limits.maxToolFailures,
        this.toolFailures,
        `工具失败次数超过上限（${this.limits.maxToolFailures} 次）`,
      );
    }
    return this.violation ? { terminate: true } : undefined;
  }

  observeAgentEvent(event: AgentEvent): boolean {
    if (event.type !== "turn_end") return this.violation !== undefined;
    this.turns += 1;
    const message = event.message;
    if (message.role === "assistant" && message.usage) {
      const usage = normalizeDependencyUsage(message.usage);
      this.tokens += usage.totalTokens;
      this.costUsd += usage.costUsd;
    }

    if (this.limits.maxTokens !== undefined && this.tokens > this.limits.maxTokens) {
      this.fail(
        "tokens",
        this.limits.maxTokens,
        this.tokens,
        `Token 消耗超过上限（${this.limits.maxTokens}）`,
      );
    }
    if (this.limits.maxCostUsd !== undefined && this.costUsd > this.limits.maxCostUsd) {
      this.fail(
        "costUsd",
        this.limits.maxCostUsd,
        this.costUsd,
        `费用超过上限（$${this.limits.maxCostUsd}）`,
      );
    }

    const requestsAnotherTurn =
      message.role === "assistant" && message.content.some((item) => item.type === "toolCall");
    if (requestsAnotherTurn && this.turns >= this.limits.maxTurns) {
      this.fail(
        "turns",
        this.limits.maxTurns,
        this.turns + 1,
        `Agent turn 将超过上限（${this.limits.maxTurns} 轮）`,
      );
    }
    return this.violation !== undefined;
  }

  throwIfExceeded(): void {
    if (!this.violation) return;
    throw new CoreMindError("budget_exceeded", this.violation.message);
  }

  private fail(
    dimension: BudgetViolation["dimension"],
    limit: number,
    actual: number,
    message: string,
  ): { block: true; reason: string } {
    if (!this.violation) {
      this.violation = { dimension, limit, actual, message };
      this.emit({ type: "budget_exceeded", dimension, limit, actual, message });
    }
    return { block: true, reason: message };
  }
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
