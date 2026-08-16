import type { CoreMindEvent } from "./events.js";
import { type RunId, receiptId } from "./ids.js";

interface ActiveEffect {
  idempotencyKey: string;
  tool: string;
  stepId?: string;
}

/** 隔离单次运行的工具副作用、幂等键和计时状态。 */
export class RunEffectCoordinator {
  private readonly activeEffects = new Map<string, ActiveEffect>();
  private readonly startedEffects = new Set<string>();
  private readonly startedAt = new Map<string, number>();

  constructor(
    private readonly runId: RunId,
    private readonly recordEvent: (event: CoreMindEvent) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  emit(event: CoreMindEvent): void {
    const enriched = this.enrich(event);
    this.recordEvent(enriched);

    if (enriched.type === "tool_call" && enriched.callId && enriched.idempotencyKey) {
      this.activeEffects.set(effectCallKey(enriched.stepId, enriched.callId), {
        idempotencyKey: enriched.idempotencyKey,
        tool: enriched.tool,
        ...(enriched.stepId ? { stepId: enriched.stepId } : {}),
      });
      return;
    }

    if (enriched.type !== "tool_result" || !enriched.callId) return;
    const callKey = effectCallKey(enriched.stepId, enriched.callId);
    const effect =
      this.activeEffects.get(callKey) ??
      this.createEffect(enriched.stepId, enriched.callId, enriched.tool);
    this.activeEffects.delete(callKey);
    const started = this.startedEffects.delete(callKey);
    this.startedAt.delete(callKey);
    this.recordEvent({
      type: "effect_receipt",
      ...effect,
      status: started ? (enriched.isError ? "unknown" : "committed") : "not_started",
    });
  }

  markStarted(stepId: string | undefined, callId: string, tool: string): void {
    const callKey = effectCallKey(stepId, callId);
    const effect = this.activeEffects.get(callKey) ?? this.createEffect(stepId, callId, tool);
    this.activeEffects.set(callKey, effect);
    this.startedEffects.add(callKey);
    this.startedAt.set(callKey, this.now());
    this.recordEvent({ type: "effect_receipt", ...effect, status: "started" });
  }

  consumeDuration(stepId: string | undefined, callId: string): number {
    const callKey = effectCallKey(stepId, callId);
    const startedAt = this.startedAt.get(callKey);
    this.startedAt.delete(callKey);
    return startedAt === undefined ? 0 : Math.max(0, this.now() - startedAt);
  }

  private enrich(event: CoreMindEvent): CoreMindEvent {
    if (
      (event.type === "tool_call" || event.type === "tool_result") &&
      event.callId &&
      !event.idempotencyKey
    ) {
      return {
        ...event,
        idempotencyKey: receiptId(this.runId, event.stepId, event.callId),
      };
    }
    return event;
  }

  private createEffect(stepId: string | undefined, callId: string, tool: string): ActiveEffect {
    return {
      idempotencyKey: receiptId(this.runId, stepId, callId),
      tool,
      ...(stepId ? { stepId } : {}),
    };
  }
}

function effectCallKey(stepId: string | undefined, callId: string): string {
  return `${stepId ?? "agent"}:${callId}`;
}
