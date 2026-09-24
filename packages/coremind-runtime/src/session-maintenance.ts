import { randomUUID } from "node:crypto";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { RunBudgetController } from "./budget.js";
import { normalizeDependencyUsage } from "./dependency-adapter.js";
import { fingerprintEffectReceiptValue } from "./effect-receipt-binding.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindEvent } from "./events.js";
import { createProviderRequestReplayFact } from "./replay-kit.js";
import type { RunStateJournal } from "./run-state.js";
import type { CoreMindSession } from "./session.js";

/** 摘要复用现有预算与事实入口；每个真实请求分别准入，禁止底层隐藏重试。 */
export async function compactSessionInRun(options: {
  runId: string;
  agent: string;
  session: CoreMindSession;
  models: Models;
  model: Model<any>;
  apiKeyOverride?: string;
  budget: RunBudgetController;
  journal: RunStateJournal;
  signal: AbortSignal;
  emit: (event: CoreMindEvent) => void;
}): Promise<void> {
  const { session, models, model, budget, journal, signal, emit, runId, agent } = options;
  signal.throwIfAborted();
  if (!budget.canRequestModel()) {
    await session.appendMaintenanceRecord({
      runId,
      status: "skipped",
      reason: "budget_unavailable",
    });
    return;
  }
  const scopedModels: Models = Object.create(models);
  scopedModels.completeSimple = async (requestModel, requestContext, requestOptions) => {
    signal.throwIfAborted();
    if (!budget.canRequestModel()) throw new CoreMindError("budget_exceeded", "摘要剩余预算不足");
    budget.beforeModelRequest();
    const requestId = randomUUID();
    const stepId = `session-compaction:${requestId}`;
    const turnId = randomUUID();
    await session.appendMaintenanceRecord({
      runId,
      requestId,
      status: "requested",
      providerId: requestModel.provider,
      modelId: requestModel.id,
      context: requestContext,
    });
    emit({ type: "agent_start", agent, stepId, turnId });
    emit({
      type: "provider_request",
      agent,
      stepId,
      ...createProviderRequestReplayFact({
        requestId,
        providerId: requestModel.provider,
        modelId: requestModel.id,
        messages: requestContext.messages,
        stablePrefix: requestContext.systemPrompt ?? "",
        toolSchemas: requestContext.tools ?? [],
        capabilityFingerprint: fingerprintEffectReceiptValue({
          provider: requestModel.provider,
          model: requestModel.id,
          contextWindow: requestModel.contextWindow,
        }),
      }),
    });
    await journal.flush("critical");
    signal.throwIfAborted();
    try {
      const response = await models.completeSimple(requestModel, requestContext, {
        ...requestOptions,
        ...(options.apiKeyOverride ? { apiKey: options.apiKeyOverride } : {}),
        signal,
        maxRetries: 0,
      });
      const usage = normalizeDependencyUsage(response.usage);
      await session.appendMaintenanceRecord({
        runId,
        requestId,
        status: response.stopReason,
        usage: response.usage,
      });
      emit({
        type: "turn_end",
        agent,
        stepId,
        turnId,
        tokens: usage.totalTokens,
        costUsd: usage.costUsd,
      });
      budget.observeAgentEvent({ type: "turn_end", ...usage });
      return response;
    } catch (error) {
      await session.appendMaintenanceRecord({
        runId,
        requestId,
        status: "failed",
        usageStatus: "unknown",
      });
      emit({ type: "turn_end", agent, stepId, turnId });
      budget.observeAgentEvent({ type: "turn_end" });
      throw error;
    } finally {
      emit({ type: "agent_end", agent, stepId, turnId });
      await journal.flush("critical");
    }
  };
  const compacted = await session.maybeCompact(
    scopedModels,
    model,
    model.contextWindow,
    {},
    signal,
    { enabled: true, maxRetries: budget.limits.maxRetries, baseDelayMs: 250 },
  );
  signal.throwIfAborted();
  budget.throwIfExceeded();
  await session.appendMaintenanceRecord({ runId, status: compacted ? "compacted" : "unchanged" });
}
