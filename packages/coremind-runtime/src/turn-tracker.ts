import { randomUUID } from "node:crypto";
import type { CoreMindEvent } from "./events.js";

/**
 * Turn 身份分配（规格 docs/spec/0.3.x-a/02-identity-and-invariants.md §2）：
 * agent_start 开启新 Turn；turn_end 带当前 TurnId 并关闭；turn 之后的工具执行
 * （tool_call / tool_result / effect_receipt）归属刚结束的 Turn；text_delta 开启下一 Turn。
 */
export class TurnTracker {
  /** 进行中的 Turn（流式期间） */
  private currentTurnId: string | undefined;
  /** 最近结束的 Turn（工具执行归属） */
  private openTurnId: string | undefined;

  private readonly scopes = new Map<string, TurnTracker>();

  withTurnId(event: CoreMindEvent): CoreMindEvent {
    if ("turnId" in event && event.turnId) return event;
    const key = `${"agent" in event ? (event.agent ?? "") : ""}\0${"stepId" in event ? (event.stepId ?? "") : ""}`;
    // 无主体的旧事件沿用最后一个作用域，保持旧事实读取兼容。
    if (key === "\0") return [...this.scopes.values()].at(-1)?.withLocalTurnId(event) ?? event;
    let tracker = this.scopes.get(key);
    if (!tracker) {
      tracker = new TurnTracker();
      this.scopes.set(key, tracker);
    }
    return tracker.withLocalTurnId(event);
  }

  private withLocalTurnId(event: CoreMindEvent): CoreMindEvent {
    switch (event.type) {
      case "agent_start": {
        const turnId = randomUUID();
        this.currentTurnId = turnId;
        this.openTurnId = turnId;
        return { ...event, turnId };
      }
      case "text_delta": {
        if (this.currentTurnId === undefined) this.currentTurnId = randomUUID();
        return event;
      }
      case "turn_end": {
        const turnId = this.currentTurnId ?? randomUUID();
        this.openTurnId = turnId;
        this.currentTurnId = undefined;
        return { ...event, turnId };
      }
      case "tool_call":
      case "tool_result":
      case "tool_lifecycle":
      case "effect_receipt": {
        if (this.openTurnId === undefined) this.openTurnId = randomUUID();
        return { ...event, turnId: this.openTurnId };
      }
      case "agent_end": {
        const enriched = this.openTurnId ? { ...event, turnId: this.openTurnId } : event;
        this.currentTurnId = undefined;
        this.openTurnId = undefined;
        return enriched;
      }
      default:
        return event;
    }
  }
}
