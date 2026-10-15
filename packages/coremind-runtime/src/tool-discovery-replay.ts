import type { AgentDriverContextContract } from "./agent-driver.js";
import { buildStableContextPrefix, type StableContextPrefixInput } from "./context.js";
import { CoreMindError } from "./errors.js";
import { createProviderRequestReplayFact } from "./replay-kit.js";
import type { RunStateRecord } from "./run-state.js";
import { restoreToolDiscovery, type ToolDiscoveryOwner } from "./tool-discovery.js";
import { TOOL_DISCOVERY_DECLARATION } from "./tool-discovery-declaration.js";

export interface ResolveToolDiscoveryRequestInput {
  records: readonly RunStateRecord[];
  owner: ToolDiscoveryOwner;
  requestId: string;
  prefixInput: Omit<StableContextPrefixInput, "tools">;
}

/** 只恢复目标请求水位的完整声明；正文与整个 Working Set 继续由 ReplayKit 校验。 */
export function resolveToolDiscoveryRequestDeclaration(
  input: ResolveToolDiscoveryRequestInput,
): AgentDriverContextContract | undefined {
  try {
    const requests = input.records.filter((record) => {
      const event = eventOf(record);
      return (
        record.runId === input.owner.runId &&
        event?.type === "provider_request" &&
        event.requestId === input.requestId
      );
    });
    if (requests.length !== 1) throw corrupt();
    const request = requests[0]!;
    const event = eventOf(request)!;
    if (event.agent !== input.owner.agent || event.stepId !== input.owner.stepId) throw corrupt();
    if (event.toolDiscovery === undefined) return undefined;
    const summary = object(event.toolDiscovery);
    if (!summary) throw corrupt();

    const records = input.records
      .filter((record) => record.runId === input.owner.runId && record.sequence <= request.sequence)
      .sort((left, right) => left.sequence - right.sequence);
    const restored = restoreToolDiscovery(records, input.owner);
    const selection = restored?.selections.at(-1);
    if (
      !restored ||
      !selection ||
      summary.version !== 1 ||
      summary.catalogFingerprint !== restored.catalog.fingerprint ||
      summary.generation !== selection.generation ||
      summary.selectionFingerprint !== selection.fingerprint ||
      summary.toolCount !== selection.names.length + 1
    )
      throw corrupt();

    const declarations = selection.names.map((name) => {
      const entry = restored.catalog.entries.find((candidate) => candidate.name === name);
      if (!entry) throw corrupt();
      return entry;
    });
    const meta = structuredClone(TOOL_DISCOVERY_DECLARATION);
    const stablePrefix = buildStableContextPrefix({
      ...input.prefixInput,
      tools: [...declarations.map(({ name, description }) => ({ name, description })), meta],
    });
    const contract: AgentDriverContextContract = {
      stablePrefix: stablePrefix.text,
      toolSchemas: [...declarations.map((entry) => structuredClone(entry.declaration)), meta],
      toolDiscovery: { generation: selection.generation, fingerprint: selection.fingerprint },
    };
    if (!text(event.providerId) || !text(event.modelId) || !text(event.capabilityFingerprint))
      throw corrupt();
    const fingerprints = createProviderRequestReplayFact({
      requestId: input.requestId,
      providerId: event.providerId,
      modelId: event.modelId,
      messages: [],
      stablePrefix: contract.stablePrefix,
      toolSchemas: contract.toolSchemas,
      capabilityFingerprint: event.capabilityFingerprint,
    });
    if (
      event.stablePrefixFingerprint !== fingerprints.stablePrefixFingerprint ||
      event.toolSchemaFingerprint !== fingerprints.toolSchemaFingerprint
    )
      throw corrupt();
    return contract;
  } catch {
    throw corrupt();
  }
}

function eventOf(record: RunStateRecord): Record<string, unknown> | undefined {
  return record.kind === "event" ? object(object(record.payload)?.event) : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function corrupt() {
  return new CoreMindError("run_state_corrupt", "请求声明事实缺失、损坏或身份不匹配");
}
