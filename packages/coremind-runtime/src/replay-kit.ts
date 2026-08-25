import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { CoreMindError } from "./errors.js";
import type { LocalObservabilityProjection } from "./observability.js";
import { ProjectionEngine, type RunProjection } from "./projection.js";
import type { RunStateRecord } from "./run-state.js";

export interface ProviderRequestReplayFixture {
  requestId: string;
  providerId: string;
  modelId: string;
  messages: readonly unknown[];
  stablePrefix: string;
  toolSchemas: readonly unknown[];
  capabilityFingerprint: string;
}

export interface ProviderRequestReplayFact {
  requestId: string;
  providerId: string;
  modelId: string;
  messageFingerprint: string;
  stablePrefixFingerprint: string;
  toolSchemaFingerprint: string;
  capabilityFingerprint: string;
  contextWorkingSetFingerprint: string;
}

export interface ReplayFixture {
  facts: readonly RunStateRecord[];
  providerRequests: readonly ProviderRequestReplayFixture[];
}

export interface ReplayResult {
  schemaVersion: 1;
  factFingerprint: string;
  replayFingerprint: string;
  projection: RunProjection;
  observation: LocalObservabilityProjection;
  providerRequests: ProviderRequestReplayFact[];
}

/** 从实际 Working Set 输入生成可持久化、无正文的 Provider 请求证据。 */
export function createProviderRequestReplayFact(
  fixture: ProviderRequestReplayFixture,
): ProviderRequestReplayFact {
  validateProviderRequestFixture(fixture);
  const messages = normalizeMessages(fixture.messages);
  const messageFingerprint = fingerprint(messages);
  const stablePrefixFingerprint = fingerprint(fixture.stablePrefix);
  const toolSchemaFingerprint = fingerprint(fixture.toolSchemas);
  return {
    requestId: fixture.requestId,
    providerId: fixture.providerId,
    modelId: fixture.modelId,
    messageFingerprint,
    stablePrefixFingerprint,
    toolSchemaFingerprint,
    capabilityFingerprint: fixture.capabilityFingerprint,
    contextWorkingSetFingerprint: fingerprint({
      providerId: fixture.providerId,
      modelId: fixture.modelId,
      messages,
      stablePrefixFingerprint,
      toolSchemaFingerprint,
      capabilityFingerprint: fixture.capabilityFingerprint,
    }),
  };
}

/** 对固定 canonical Facts 与请求 fixture 执行无副作用、可重复的本地重放。 */
export const ReplayKit = {
  replay(fixture: ReplayFixture): ReplayResult {
    const projection = ProjectionEngine.project(structuredClone(fixture.facts));
    const providerRequests = fixture.providerRequests.map((request) =>
      createProviderRequestReplayFact(structuredClone(request)),
    );
    const persistedRequests = projection.trace.flatMap((entry) =>
      entry.event.type === "provider_request" ? [providerRequestFactOf(entry.event)] : [],
    );
    if (canonicalJson(persistedRequests) !== canonicalJson(providerRequests)) {
      throw new CoreMindError(
        "run_state_corrupt",
        "Provider request fixture 与持久 Working Set 指纹不一致",
      );
    }
    const factFingerprint = fingerprint(projection.records);
    const replayFingerprint = fingerprint({
      factFingerprint,
      projection,
      providerRequests,
    });
    return {
      schemaVersion: 1,
      factFingerprint,
      replayFingerprint,
      projection,
      observation: projection.observability,
      providerRequests,
    };
  },
};

function validateProviderRequestFixture(fixture: ProviderRequestReplayFixture): void {
  if (
    !isNonBlankString(fixture.requestId) ||
    !isNonBlankString(fixture.providerId) ||
    !isNonBlankString(fixture.modelId) ||
    !Array.isArray(fixture.messages) ||
    !isNonBlankString(fixture.stablePrefix) ||
    !Array.isArray(fixture.toolSchemas) ||
    !isNonBlankString(fixture.capabilityFingerprint)
  ) {
    throw new CoreMindError(
      "run_state_corrupt",
      "Provider request replay fixture 缺少 canonical Working Set 输入",
    );
  }
}

function providerRequestFactOf(value: ProviderRequestReplayFact): ProviderRequestReplayFact {
  return {
    requestId: value.requestId,
    providerId: value.providerId,
    modelId: value.modelId,
    messageFingerprint: value.messageFingerprint,
    stablePrefixFingerprint: value.stablePrefixFingerprint,
    toolSchemaFingerprint: value.toolSchemaFingerprint,
    capabilityFingerprint: value.capabilityFingerprint,
    contextWorkingSetFingerprint: value.contextWorkingSetFingerprint,
  };
}

function normalizeMessages(messages: readonly unknown[]): unknown[] {
  return messages.map((message) => removeVolatileTimestamps(structuredClone(message)));
}

function removeVolatileTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeVolatileTimestamps);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "timestamp")
      .map(([key, item]) => [key, removeVolatileTimestamps(item)]),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
