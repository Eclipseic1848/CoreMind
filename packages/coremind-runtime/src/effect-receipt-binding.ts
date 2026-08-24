import { createHash } from "node:crypto";
import type { ResolvedToolCapability } from "coremind-tools";
import { canonicalJson } from "./canonical-json.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent, EffectReceiptStatus } from "./events.js";
import { receiptId } from "./ids.js";

export interface EffectReceiptBinding {
  version: 1;
  runId: string;
  turnId: string;
  agent: string;
  stepId?: string;
  callId: string;
  tool: string;
  argumentsFingerprint: string;
  capabilityFingerprint: string;
}

export interface EffectReceiptBindingProjection {
  idempotencyKey: string;
  status: EffectReceiptStatus;
  provenance: "bound" | "legacy";
  binding?: EffectReceiptBinding;
}

export function fingerprintEffectReceiptValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createEffectReceiptBinding(input: {
  runId: string;
  turnId: string;
  agent: string;
  stepId?: string;
  callId: string;
  tool: string;
  args: unknown;
  capability: ResolvedToolCapability;
}): EffectReceiptBinding {
  return {
    version: 1,
    runId: input.runId,
    turnId: input.turnId,
    agent: input.agent,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    callId: input.callId,
    tool: input.tool,
    argumentsFingerprint: fingerprintEffectReceiptValue(input.args),
    capabilityFingerprint: fingerprintEffectReceiptValue(input.capability),
  };
}

export function projectEffectReceiptBindings(
  events: readonly CoreMindEvent[],
): EffectReceiptBindingProjection[] {
  const projected = new Map<string, EffectReceiptBindingProjection>();
  for (const event of events) {
    if (event.type !== "effect_receipt") continue;
    const previous = projected.get(event.idempotencyKey);
    if (!isLegalTransition(previous?.status, event.status)) {
      throw new CoreMindError(
        "effect_receipt_conflict",
        `EffectReceipt ${event.idempotencyKey} 状态从 ${previous?.status ?? "初始"} 非法迁移到 ${event.status}`,
      );
    }
    if (event.binding) validateBinding(event);
    if (
      previous?.binding &&
      event.binding &&
      canonicalJson(previous.binding) !== canonicalJson(event.binding)
    ) {
      throw new CoreMindError(
        "effect_receipt_conflict",
        `EffectReceipt ${event.idempotencyKey} 关联了不同的身份或指纹`,
      );
    }
    if (previous?.provenance === "bound" && !event.binding) {
      throw new CoreMindError(
        "effect_receipt_conflict",
        `EffectReceipt ${event.idempotencyKey} 从 bound 降级为 legacy`,
      );
    }
    const binding =
      previous?.provenance === "legacy" ? undefined : (event.binding ?? previous?.binding);
    projected.set(event.idempotencyKey, {
      idempotencyKey: event.idempotencyKey,
      status: event.status,
      provenance: binding ? "bound" : "legacy",
      ...(binding ? { binding: structuredClone(binding) } : {}),
    });
  }
  return [...projected.values()];
}

/** 从同一 Run 的原始 Call 与 Capability 事实重算绑定，拒绝仅链内自洽的伪造指纹。 */
export function validateEffectReceiptBindingsAgainstFacts(
  runId: string,
  events: readonly CoreMindEvent[],
): EffectReceiptBindingProjection[] {
  const calls = new Map<
    string,
    Extract<CoreMindEvent, { type: "tool_call" }> & { callId: string; turnId: string }
  >();
  const capabilities = new Map<string, Extract<CoreMindEvent, { type: "capability_resolved" }>>();
  for (const event of events) {
    if (event.type === "tool_call" && event.callId && event.turnId) {
      const key = bindingCallKey(event.agent, event.stepId, event.callId);
      const previous = calls.get(key);
      if (previous && canonicalJson(previous) !== canonicalJson(event)) {
        throw new CoreMindError(
          "effect_receipt_conflict",
          `Tool Call ${event.callId} 的参数或身份在 Run 内发生变化`,
        );
      }
      calls.set(key, event as typeof event & { callId: string; turnId: string });
      continue;
    }
    if (event.type === "capability_resolved") {
      const key = bindingCallKey(event.agent, event.stepId, event.callId);
      const previous = capabilities.get(key);
      if (previous && canonicalJson(previous.capability) !== canonicalJson(event.capability)) {
        throw new CoreMindError(
          "effect_receipt_conflict",
          `Tool Call ${event.callId} 的 Capability 在 Run 内发生变化`,
        );
      }
      capabilities.set(key, event);
      continue;
    }
    if (event.type !== "effect_receipt" || !event.binding) continue;
    validateBinding(event);
    const key = bindingCallKey(event.binding.agent, event.binding.stepId, event.binding.callId);
    const call = calls.get(key);
    const capability = capabilities.get(key);
    if (!call || !capability || capability.tool !== call.tool) {
      throw new CoreMindError(
        "effect_receipt_conflict",
        `EffectReceipt ${event.idempotencyKey} 缺少可验证的 Tool Call 或 Capability 前缀`,
      );
    }
    const expected = createEffectReceiptBinding({
      runId,
      turnId: call.turnId,
      agent: call.agent,
      ...(call.stepId ? { stepId: call.stepId } : {}),
      callId: call.callId,
      tool: call.tool,
      args: call.args,
      capability: capability.capability,
    });
    if (call.argumentsFingerprint) {
      expected.argumentsFingerprint = call.argumentsFingerprint;
    }
    if (canonicalJson(expected) !== canonicalJson(event.binding)) {
      const expectedFields = expected as unknown as Record<string, unknown>;
      const actualFields = event.binding as unknown as Record<string, unknown>;
      const mismatchedFields = Object.keys(expectedFields).filter(
        (field) => canonicalJson(expectedFields[field]) !== canonicalJson(actualFields[field]),
      );
      throw new CoreMindError(
        "effect_receipt_conflict",
        `EffectReceipt ${event.idempotencyKey} 与原始 Tool Call 或 Capability 事实不一致：${mismatchedFields.join(", ")}`,
      );
    }
  }
  return projectEffectReceiptBindings(events);
}

function validateBinding(event: Extract<CoreMindEvent, { type: "effect_receipt" }>): void {
  const binding = event.binding!;
  if (
    binding.version !== 1 ||
    binding.tool !== event.tool ||
    event.agent !== binding.agent ||
    event.callId !== binding.callId ||
    event.turnId !== binding.turnId ||
    event.idempotencyKey !== receiptId(binding.runId, binding.stepId, binding.callId) ||
    binding.argumentsFingerprint.length !== 64 ||
    binding.capabilityFingerprint.length !== 64
  ) {
    throw new CoreMindError(
      "effect_receipt_conflict",
      `EffectReceipt ${event.idempotencyKey} 的绑定与事件身份不一致`,
    );
  }
}

function isLegalTransition(
  previous: EffectReceiptStatus | undefined,
  next: EffectReceiptStatus,
): boolean {
  if (previous === undefined) return next === "not_started" || next === "started";
  return previous === "started" && (next === "committed" || next === "unknown");
}

function bindingCallKey(agent: string, stepId: string | undefined, callId: string): string {
  return `${agent}\u0000${stepId ?? ""}\u0000${callId}`;
}
