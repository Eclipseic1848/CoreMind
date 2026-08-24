import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type AgentMessage, estimateTokens } from "@earendil-works/pi-agent-core";
import { canonicalJson } from "./canonical-json.js";
import type { CoreMindMessage } from "./public-message.js";

export type ContextCapabilitySource =
  | "locked_catalog"
  | "explicit_config"
  | "provider_metadata"
  | "conservative_fallback";

export type ContextCapabilityConfidence = "verified" | "declared" | "assumed" | "conflicting";

export interface ContextCapabilityCandidate {
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  source: ContextCapabilitySource;
  confidence: ContextCapabilityConfidence;
}

export interface ResolvedContextCapability {
  providerId: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  source: ContextCapabilitySource;
  confidence: Exclude<ContextCapabilityConfidence, "conflicting">;
  configFingerprint: string;
  resolvedAt: number;
}

export type ContextCapabilityEvidence =
  | {
      type: "safe_context_intersection";
      candidateCount: number;
      effectiveContextWindow: number;
      effectiveMaxOutputTokens: number;
    }
  | {
      type: "assumed_context_window";
      contextWindow: number;
      maxOutputTokens: number;
    };

export interface ContextLifecyclePrepareInput {
  providerId: string;
  modelId: string;
  resolvedAt: number;
  capabilityCandidates: ContextCapabilityCandidate[];
  request: ContextLifecycleRequest;
}

export interface ContextLifecyclePreparation {
  capability: ResolvedContextCapability;
  evidence: ContextCapabilityEvidence[];
  budget: ContextRequestBudget;
  workingSet: ContextWorkingSet;
  compaction?: ContextCompactionPreparation;
}

export interface ContextLifecycleRequest {
  messages: CoreMindMessage[];
  stablePrefix: string;
  toolSchemas: unknown[];
  structuredOutputSchema?: unknown;
  requestedMaxOutputTokens?: number;
  multimodalOccupancyTokens?: number;
  protocolOverheadTokens?: number;
  safetyMarginTokens?: number;
  taskState: ContextTaskState;
  workspaceRoot?: string;
  artifactReferences: ContextArtifactReference[];
  canonicalMessages: CoreMindMessage[];
  previousCompactions: ContextCompactionLedgerEntry[];
  lineageDepthLimit?: number;
  compactionTrigger: ContextCompactionTrigger;
}

export interface ContextArtifactReference {
  artifactId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ContextTaskState {
  goal: string;
  constraints: string[];
  approvals: string[];
  uncertainEffects: string[];
  activePlan: string[];
  modifiedFiles: string[];
  tests: string[];
  incompleteTasks: string[];
  nextStep: string;
  sourceFacts: ContextTaskStateSourceFacts;
}

export interface ContextTaskStateSourceFacts {
  goal: string[];
  constraints: string[];
  approvals: string[];
  uncertainEffects: string[];
  activePlan: string[];
  modifiedFiles: string[];
  tests: string[];
  incompleteTasks: string[];
  nextStep: string[];
}

export interface ContextRequestBudget {
  effectiveContextWindow: number;
  reservedOutputTokens: number;
  stablePrefixTokens: number;
  toolSchemaTokens: number;
  structuredOutputTokens: number;
  multimodalTokens: number;
  protocolOverheadTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  messageTokens: number;
  estimator: "pi-agent-core-estimate-v1";
}

export interface ContextWorkingSet {
  messages: CoreMindMessage[];
  compacted: boolean;
  tokens: number;
}

export interface ContextWorkingSetBuildResult {
  workingSet: ContextWorkingSet;
  compaction?: ContextCompactionPreparation;
}

export interface ContextCompactionPreparation {
  reason: "threshold";
  removedMessages: number;
  replacedRange: { start: number; end: number };
  tokensBefore: number;
  tokensAfter: number;
  taskStateFingerprint: string;
  summaryFingerprint: string;
  retainedTailFingerprint: string;
  ledgerEntry: ContextCompactionLedgerEntry;
}

export type ContextCompactionTrigger = "threshold" | "model_switch" | "provider_overflow";

export interface ContextCompactionLedgerEntry {
  compactionId: string;
  parentCompactionId?: string;
  sourceFingerprint: string;
  sourceRange: { start: number; end: number };
  strategyId: "task-state";
  strategyVersion: 1;
  capabilityFingerprint: string;
  budget: {
    availableInputTokens: number;
    estimator: ContextRequestBudget["estimator"];
  };
  tokensBefore: number;
  tokensAfter: number;
  summaryFingerprint: string;
  retainedTailFingerprint: string;
  taskStateFingerprint: string;
  lineageDepth: number;
  rebuiltFromCanonical: boolean;
  createdAt: number;
  trigger: ContextCompactionTrigger;
}

export type ContextLifecycleFailureReason =
  | "unknown"
  | "conflicting"
  | "route_mismatch"
  | "invalid_candidate"
  | "invalid_budget"
  | "multimodal_occupancy_unknown"
  | "provider_overflow"
  | "budget_exhausted"
  | "undeletable_set_exceeds_budget"
  | "artifact_missing"
  | "lineage_corrupt";

export type ContextLifecycleErrorCode =
  | "context_capability_conflict"
  | "context_budget_exhausted"
  | "context_artifact_missing"
  | "context_lineage_corrupt";

export class ContextLifecycleError extends Error {
  readonly name = "ContextLifecycleError";
  readonly pausable: boolean;

  constructor(
    message: string,
    readonly reason: ContextLifecycleFailureReason,
    readonly code: ContextLifecycleErrorCode = "context_capability_conflict",
    readonly artifactId?: string,
  ) {
    super(message);
    this.pausable = code !== "context_lineage_corrupt";
  }
}

export class CompactionLedger {
  readonly entries: readonly ContextCompactionLedgerEntry[];

  constructor(
    entries: readonly ContextCompactionLedgerEntry[],
    readonly depthLimit = 8,
  ) {
    if (!Number.isSafeInteger(depthLimit) || depthLimit < 1) throwLineageCorrupt();
    validateLedgerEntries(entries, depthLimit);
    this.entries = entries;
  }

  latest(): ContextCompactionLedgerEntry | undefined {
    return this.entries.at(-1);
  }

  shouldRebuildFromCanonical(): boolean {
    return (this.latest()?.lineageDepth ?? 0) >= this.depthLimit;
  }

  createEntry(
    input: Omit<
      ContextCompactionLedgerEntry,
      "compactionId" | "parentCompactionId" | "lineageDepth"
    >,
  ): ContextCompactionLedgerEntry {
    const latest = this.latest();
    const unsigned = {
      ...input,
      ...(latest ? { parentCompactionId: latest.compactionId } : {}),
      lineageDepth: input.rebuiltFromCanonical ? 1 : (latest?.lineageDepth ?? 0) + 1,
    };
    return { compactionId: fingerprint(unsigned), ...unsigned };
  }
}

/** 每次 Provider 请求前解析具体路由的 Context Capability；后续预算与工作集也只从此入口生成。 */
export class ContextLifecycleManager {
  constructor(private readonly workingSetBuilder = new ContextWorkingSetBuilder()) {}

  async prepare(input: ContextLifecyclePrepareInput): Promise<ContextLifecyclePreparation> {
    const candidates = validateCandidates(input);
    const contextWindow = Math.min(...candidates.map((candidate) => candidate.contextWindow));
    const maxOutputTokens = Math.min(...candidates.map((candidate) => candidate.maxOutputTokens));
    if (maxOutputTokens >= contextWindow) {
      throw new ContextLifecycleError(
        "Context Capability 的输出上限不能占满或超过总窗口",
        "invalid_candidate",
      );
    }

    const governing = [...candidates].sort(compareGoverningCandidate)[0]!;
    const capability: ResolvedContextCapability = {
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow,
      maxOutputTokens,
      source: governing.source,
      confidence: weakestConfidence(candidates),
      configFingerprint: fingerprint({
        providerId: input.providerId,
        modelId: input.modelId,
        candidates: [...candidates].sort(compareCandidateIdentity),
      }),
      resolvedAt: input.resolvedAt,
    };
    const evidence: ContextCapabilityEvidence[] = [];
    if (candidates.length > 1) {
      evidence.push({
        type: "safe_context_intersection",
        candidateCount: candidates.length,
        effectiveContextWindow: contextWindow,
        effectiveMaxOutputTokens: maxOutputTokens,
      });
    }
    if (candidates.some((candidate) => candidate.source === "conservative_fallback")) {
      evidence.push({ type: "assumed_context_window", contextWindow, maxOutputTokens });
    }
    await validateArtifactReferences(input.request);
    const ledger = new CompactionLedger(
      input.request.previousCompactions,
      input.request.lineageDepthLimit ?? 8,
    );
    const effectiveTrigger: ContextCompactionTrigger =
      input.request.compactionTrigger === "provider_overflow"
        ? "provider_overflow"
        : ledger.latest() && ledger.latest()!.capabilityFingerprint !== capability.configFingerprint
          ? "model_switch"
          : input.request.compactionTrigger;
    const routedRequest: ContextLifecycleRequest =
      effectiveTrigger === input.request.compactionTrigger
        ? input.request
        : { ...input.request, compactionTrigger: effectiveTrigger };
    const currentBudget = buildRequestBudget(capability, routedRequest);
    const rebuildFromCanonical =
      currentBudget.messageTokens > currentBudget.availableInputTokens &&
      ledger.shouldRebuildFromCanonical();
    if (rebuildFromCanonical && input.request.canonicalMessages.length === 0) {
      throwLineageCorrupt();
    }
    const sourceRequest = rebuildFromCanonical
      ? { ...routedRequest, messages: routedRequest.canonicalMessages }
      : routedRequest;
    const budget = rebuildFromCanonical
      ? buildRequestBudget(capability, sourceRequest)
      : currentBudget;
    const prepared = this.workingSetBuilder.build(
      sourceRequest,
      budget,
      capability,
      ledger,
      input.resolvedAt,
      rebuildFromCanonical,
    );
    return { capability, evidence, budget, ...prepared };
  }
}

/** 只消费已解析能力、完整预算与 canonical facts，生成本次有界 Provider Working Set。 */
export class ContextWorkingSetBuilder {
  build(
    request: ContextLifecycleRequest,
    budget: ContextRequestBudget,
    capability: ResolvedContextCapability,
    ledger: CompactionLedger,
    resolvedAt: number,
    forceCompaction: boolean,
  ): ContextWorkingSetBuildResult {
    return buildWorkingSet(request, budget, capability, ledger, resolvedAt, forceCompaction);
  }
}

async function validateArtifactReferences(request: ContextLifecycleRequest): Promise<void> {
  if (request.artifactReferences.length === 0) return;
  if (!request.workspaceRoot) throwArtifactMissing(request.artifactReferences[0]!.artifactId);

  const workspaceRoot = path.resolve(request.workspaceRoot);
  const artifactRoot = path.resolve(workspaceRoot, ".coremind", "artifacts");
  let realArtifactRoot: string;
  try {
    realArtifactRoot = await realpath(artifactRoot);
  } catch {
    throwArtifactMissing(request.artifactReferences[0]!.artifactId);
  }

  for (const reference of request.artifactReferences) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(reference.artifactId) ||
      !Number.isSafeInteger(reference.sizeBytes) ||
      reference.sizeBytes < 0 ||
      !/^[a-f0-9]{64}$/.test(reference.sha256)
    ) {
      throwArtifactMissing(reference.artifactId);
    }
    const candidate = path.resolve(workspaceRoot, reference.relativePath);
    if (!isStrictChild(artifactRoot, candidate)) throwArtifactMissing(reference.artifactId);
    try {
      const realCandidate = await realpath(candidate);
      if (!isStrictChild(realArtifactRoot, realCandidate))
        throwArtifactMissing(reference.artifactId);
      const metadata = await stat(realCandidate);
      if (!metadata.isFile() || metadata.size !== reference.sizeBytes) {
        throwArtifactMissing(reference.artifactId);
      }
      if ((await hashFile(realCandidate)) !== reference.sha256) {
        throwArtifactMissing(reference.artifactId);
      }
    } catch (error) {
      if (error instanceof ContextLifecycleError) throw error;
      throwArtifactMissing(reference.artifactId);
    }
  }
}

function buildWorkingSet(
  request: ContextLifecycleRequest,
  budget: ContextRequestBudget,
  capability: ResolvedContextCapability,
  ledger: CompactionLedger,
  resolvedAt: number,
  forceCompaction: boolean,
): ContextWorkingSetBuildResult {
  if (!forceCompaction && budget.messageTokens <= budget.availableInputTokens) {
    return {
      workingSet: {
        messages: request.messages,
        compacted: false,
        tokens: budget.messageTokens,
      },
    };
  }

  const tailStart = findLastUserIndex(request.messages);
  if (tailStart <= 0) throwUndeletableSetExceeded();
  const retainedTail = request.messages.slice(tailStart);
  const summaryText = `[CoreMind TaskState v1]\n${canonicalJson(request.taskState)}`;
  const summary: CoreMindMessage = { role: "user", content: summaryText, timestamp: resolvedAt };
  const messages = [summary, ...retainedTail];
  const tokens = estimateMessageTokens(messages);
  if (tokens > budget.availableInputTokens) throwUndeletableSetExceeded();
  const taskStateFingerprint = fingerprint(request.taskState);
  const summaryFingerprint = fingerprint(summaryText);
  const retainedTailFingerprint = fingerprint(retainedTail);
  const ledgerEntry = ledger.createEntry({
    sourceFingerprint: fingerprint(request.messages),
    sourceRange: { start: 0, end: tailStart },
    strategyId: "task-state",
    strategyVersion: 1,
    capabilityFingerprint: capability.configFingerprint,
    budget: {
      availableInputTokens: budget.availableInputTokens,
      estimator: budget.estimator,
    },
    tokensBefore: budget.messageTokens,
    tokensAfter: tokens,
    summaryFingerprint,
    retainedTailFingerprint,
    taskStateFingerprint,
    rebuiltFromCanonical: forceCompaction,
    createdAt: resolvedAt,
    trigger: request.compactionTrigger,
  });

  return {
    workingSet: { messages, compacted: true, tokens },
    compaction: {
      reason: "threshold",
      removedMessages: tailStart,
      replacedRange: { start: 0, end: tailStart },
      tokensBefore: budget.messageTokens,
      tokensAfter: tokens,
      taskStateFingerprint,
      summaryFingerprint,
      retainedTailFingerprint,
      ledgerEntry,
    },
  };
}

function buildRequestBudget(
  capability: ResolvedContextCapability,
  request: ContextLifecycleRequest,
): ContextRequestBudget {
  const requestedOutput = request.requestedMaxOutputTokens ?? capability.maxOutputTokens;
  const protocolOverheadTokens = request.protocolOverheadTokens ?? 32 + request.messages.length * 8;
  const safetyMarginTokens =
    request.safetyMarginTokens ?? Math.max(128, Math.ceil(capability.contextWindow * 0.02));
  if (
    !Number.isSafeInteger(requestedOutput) ||
    requestedOutput <= 0 ||
    !Number.isSafeInteger(protocolOverheadTokens) ||
    protocolOverheadTokens < 0 ||
    !Number.isSafeInteger(safetyMarginTokens) ||
    safetyMarginTokens < 0
  ) {
    throw new ContextLifecycleError(
      "Context 请求预算包含无效的输出、协议或安全余量",
      "invalid_budget",
    );
  }

  const reservedOutputTokens = Math.min(
    capability.maxOutputTokens,
    requestedOutput,
    Math.max(1, Math.floor(capability.contextWindow * 0.25)),
  );
  const stablePrefixTokens = estimateTextTokens(request.stablePrefix);
  const toolSchemaTokens =
    request.toolSchemas.length === 0 ? 0 : estimateTextTokens(canonicalJson(request.toolSchemas));
  const structuredOutputTokens =
    request.structuredOutputSchema === undefined
      ? 0
      : estimateTextTokens(canonicalJson(request.structuredOutputSchema));
  const containsImage = request.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((content) => content.type === "image"),
  );
  if (containsImage && request.multimodalOccupancyTokens === undefined) {
    throw new ContextLifecycleError(
      "Context 包含图片，但当前路由没有提供可信的多模态占用",
      "multimodal_occupancy_unknown",
      "context_budget_exhausted",
    );
  }
  const multimodalTokens = request.multimodalOccupancyTokens ?? 0;
  if (!Number.isSafeInteger(multimodalTokens) || multimodalTokens < 0) {
    throw new ContextLifecycleError("Context 请求包含无效的多模态占用", "invalid_budget");
  }
  const messageTokens = estimateMessageTokens(request.messages);
  const availableInputTokens =
    capability.contextWindow -
    reservedOutputTokens -
    stablePrefixTokens -
    toolSchemaTokens -
    structuredOutputTokens -
    multimodalTokens -
    protocolOverheadTokens -
    safetyMarginTokens;
  if (availableInputTokens < 0) {
    throw new ContextLifecycleError(
      "稳定前缀、工具 Schema、协议和安全余量已超过 Context 输入预算",
      "budget_exhausted",
      "context_budget_exhausted",
    );
  }
  return {
    effectiveContextWindow: capability.contextWindow,
    reservedOutputTokens,
    stablePrefixTokens,
    toolSchemaTokens,
    structuredOutputTokens,
    multimodalTokens,
    protocolOverheadTokens,
    safetyMarginTokens,
    availableInputTokens,
    messageTokens,
    estimator: "pi-agent-core-estimate-v1",
  };
}

function validateCandidates(input: ContextLifecyclePrepareInput): ContextCapabilityCandidate[] {
  if (input.capabilityCandidates.length === 0) {
    throw new ContextLifecycleError(
      `模型 ${input.providerId}/${input.modelId} 没有可验证的 Context Capability`,
      "unknown",
    );
  }
  for (const candidate of input.capabilityCandidates) {
    if (candidate.providerId !== input.providerId || candidate.modelId !== input.modelId) {
      throw new ContextLifecycleError(
        `Context Capability 候选不属于本次路由 ${input.providerId}/${input.modelId}`,
        "route_mismatch",
      );
    }
    if (candidate.confidence === "conflicting") {
      throw new ContextLifecycleError(
        `模型 ${input.providerId}/${input.modelId} 的 Context Capability 存在冲突`,
        "conflicting",
      );
    }
    if (
      !Number.isSafeInteger(candidate.contextWindow) ||
      candidate.contextWindow <= 1 ||
      !Number.isSafeInteger(candidate.maxOutputTokens) ||
      candidate.maxOutputTokens <= 0
    ) {
      throw new ContextLifecycleError(
        `模型 ${input.providerId}/${input.modelId} 的 Context Capability 候选无效`,
        "invalid_candidate",
      );
    }
  }
  return input.capabilityCandidates;
}

function weakestConfidence(
  candidates: ContextCapabilityCandidate[],
): Exclude<ContextCapabilityConfidence, "conflicting"> {
  const rank = { verified: 0, declared: 1, assumed: 2 } as const;
  return candidates
    .map((candidate) => candidate.confidence as keyof typeof rank)
    .sort((left, right) => rank[right] - rank[left])[0]!;
}

function compareGoverningCandidate(
  left: ContextCapabilityCandidate,
  right: ContextCapabilityCandidate,
): number {
  return (
    left.contextWindow - right.contextWindow ||
    left.maxOutputTokens - right.maxOutputTokens ||
    compareCandidateIdentity(left, right)
  );
}

function compareCandidateIdentity(
  left: ContextCapabilityCandidate,
  right: ContextCapabilityCandidate,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right), "en");
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function estimateTextTokens(value: string): number {
  if (value.length === 0) return 0;
  return estimateTokens({ role: "user", content: value, timestamp: 0 });
}

function estimateMessageTokens(messages: CoreMindMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message as unknown as AgentMessage),
    0,
  );
}

function findLastUserIndex(messages: CoreMindMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }
  return -1;
}

function throwUndeletableSetExceeded(): never {
  throw new ContextLifecycleError(
    "Context TaskState 与最近完整 Turn 已超过可用输入预算，不能安全截断",
    "undeletable_set_exceeds_budget",
    "context_budget_exhausted",
  );
}

function throwArtifactMissing(artifactId: string): never {
  throw new ContextLifecycleError(
    `Artifact ${artifactId} 无法在受控根目录内验证`,
    "artifact_missing",
    "context_artifact_missing",
    artifactId,
  );
}

function throwLineageCorrupt(): never {
  throw new ContextLifecycleError(
    "Compaction Ledger 无法验证，不能安全重建 Context lineage",
    "lineage_corrupt",
    "context_lineage_corrupt",
  );
}

function validateLedgerEntries(
  entries: readonly ContextCompactionLedgerEntry[],
  depthLimit: number,
): void {
  let previous: ContextCompactionLedgerEntry | undefined;
  for (const entry of entries) {
    if (!isValidLedgerEntry(entry)) throwLineageCorrupt();
    const { compactionId, ...unsigned } = entry;
    if (fingerprint(unsigned) !== compactionId) throwLineageCorrupt();
    if (entry.parentCompactionId !== previous?.compactionId) throwLineageCorrupt();
    const expectedDepth = entry.rebuiltFromCanonical ? 1 : (previous?.lineageDepth ?? 0) + 1;
    if (entry.lineageDepth !== expectedDepth || entry.lineageDepth > depthLimit) {
      throwLineageCorrupt();
    }
    previous = entry;
  }
}

function isValidLedgerEntry(entry: ContextCompactionLedgerEntry): boolean {
  return (
    isSha256(entry.compactionId) &&
    (entry.parentCompactionId === undefined || isSha256(entry.parentCompactionId)) &&
    isSha256(entry.sourceFingerprint) &&
    Number.isSafeInteger(entry.sourceRange.start) &&
    entry.sourceRange.start === 0 &&
    Number.isSafeInteger(entry.sourceRange.end) &&
    entry.sourceRange.end > 0 &&
    entry.strategyId === "task-state" &&
    entry.strategyVersion === 1 &&
    isSha256(entry.capabilityFingerprint) &&
    Number.isSafeInteger(entry.budget.availableInputTokens) &&
    entry.budget.availableInputTokens >= 0 &&
    entry.budget.estimator === "pi-agent-core-estimate-v1" &&
    Number.isSafeInteger(entry.tokensBefore) &&
    entry.tokensBefore >= 0 &&
    Number.isSafeInteger(entry.tokensAfter) &&
    entry.tokensAfter >= 0 &&
    isSha256(entry.summaryFingerprint) &&
    isSha256(entry.retainedTailFingerprint) &&
    isSha256(entry.taskStateFingerprint) &&
    Number.isSafeInteger(entry.lineageDepth) &&
    entry.lineageDepth >= 1 &&
    typeof entry.rebuiltFromCanonical === "boolean" &&
    Number.isFinite(entry.createdAt) &&
    isCompactionTrigger(entry.trigger)
  );
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isCompactionTrigger(value: string): value is ContextCompactionTrigger {
  return value === "threshold" || value === "model_switch" || value === "provider_overflow";
}

function isStrictChild(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
