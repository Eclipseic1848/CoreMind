import {
  isResolvedToolCapability,
  type RecoveryDisposition,
  type ResolvedToolCapability,
  recoveryDispositionFor,
  resolveToolCapability,
} from "coremind-tools";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import type { RunStateRecord } from "./run-state.js";
import { toolCapabilityCallKey } from "./tool-capability-identity.js";

export interface ToolCapabilityProjection {
  agent: string;
  callId?: string;
  stepId?: string;
  tool: string;
  capability: ResolvedToolCapability;
  recoveryDisposition: RecoveryDisposition;
  provenance: "current" | "legacy";
}

/** 从同一 Runtime 的规范化 Fact 生成入口共享的 Capability 视图。 */
export function projectToolCapabilities(
  events: readonly CoreMindEvent[],
): ToolCapabilityProjection[] {
  const resolvedByCall = new Map<string, Extract<CoreMindEvent, { type: "capability_resolved" }>>();
  for (const event of events) {
    if (event.type === "capability_resolved") {
      const callKey = toolCapabilityCallKey(event.agent, event.stepId, event.callId);
      const previous = resolvedByCall.get(callKey);
      if (
        !isResolvedToolCapability(event.capability, event.tool) ||
        recoveryDispositionFor(event.capability) !== event.recoveryDisposition ||
        (previous && !sameCapabilityFact(previous, event))
      ) {
        throw capabilityConflict(event.agent, event.stepId, event.callId);
      }
      resolvedByCall.set(callKey, event);
    }
  }

  const projections: ToolCapabilityProjection[] = [];
  const seenCalls = new Map<string, string>();
  for (const [eventIndex, event] of events.entries()) {
    if (event.type !== "tool_call") continue;
    const callKey = event.callId
      ? toolCapabilityCallKey(event.agent, event.stepId, event.callId)
      : `legacy\u0000${eventIndex}`;
    const seenTool = seenCalls.get(callKey);
    if (seenTool !== undefined && seenTool !== event.tool) {
      throw capabilityConflict(event.agent, event.stepId, event.callId!);
    }
    if (seenTool !== undefined) continue;
    seenCalls.set(callKey, event.tool);
    const current = event.callId ? resolvedByCall.get(callKey) : undefined;
    if (current && current.tool !== event.tool) {
      throw capabilityConflict(event.agent, event.stepId, event.callId!);
    }
    if (current) {
      projections.push({
        agent: event.agent,
        ...(event.callId ? { callId: event.callId } : {}),
        ...(event.stepId ? { stepId: event.stepId } : {}),
        tool: event.tool,
        capability: current.capability,
        recoveryDisposition: current.recoveryDisposition,
        provenance: "current",
      });
      continue;
    }

    const capability = legacyUnknownCapability(event.tool);
    projections.push({
      agent: event.agent,
      ...(event.callId ? { callId: event.callId } : {}),
      ...(event.stepId ? { stepId: event.stepId } : {}),
      tool: event.tool,
      capability,
      recoveryDisposition: recoveryDispositionFor(capability),
      provenance: "legacy",
    });
  }
  return projections;
}

function sameCapabilityFact(
  left: Extract<CoreMindEvent, { type: "capability_resolved" }>,
  right: Extract<CoreMindEvent, { type: "capability_resolved" }>,
): boolean {
  return (
    left.tool === right.tool &&
    left.recoveryDisposition === right.recoveryDisposition &&
    left.capability.effect === right.capability.effect &&
    left.capability.replay === right.capability.replay &&
    left.capability.concurrency === right.capability.concurrency &&
    left.capability.checkpoint === right.capability.checkpoint &&
    left.capability.durability === right.capability.durability &&
    left.capability.source === right.capability.source &&
    left.capability.resolution === right.capability.resolution &&
    left.capability.issues.length === right.capability.issues.length &&
    left.capability.issues.every((issue, index) => issue === right.capability.issues[index])
  );
}

function capabilityConflict(
  agent: string,
  stepId: string | undefined,
  callId: string,
): CoreMindError {
  return new CoreMindError(
    "tool_capability_conflict",
    `Call ${agent}/${stepId ?? "-"}/${callId} 出现冲突或非法 Tool Capability Fact`,
  );
}

/** 0.3.0/0.3.1 RunState 读取端：只使用当时已持久化的 Fact，不按名称补写结论。 */
export function projectToolCapabilitiesFromRecords(
  records: readonly RunStateRecord[],
): ToolCapabilityProjection[] {
  return projectToolCapabilities(records.flatMap(eventFromRecord));
}

function eventFromRecord(record: RunStateRecord): CoreMindEvent[] {
  if (record.kind !== "event" || record.payload === null || typeof record.payload !== "object") {
    return [];
  }
  const event = (record.payload as { event?: unknown }).event;
  if (event === null || typeof event !== "object" || !("type" in event)) return [];
  return [event as CoreMindEvent];
}

function legacyUnknownCapability(tool: string): ResolvedToolCapability {
  return resolveToolCapability({
    tool,
    source: "inferred",
    declaration: {},
  });
}
