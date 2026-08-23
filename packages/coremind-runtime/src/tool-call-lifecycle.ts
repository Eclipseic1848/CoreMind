import type { RecoveryDisposition } from "coremind-tools";
import { CoreMindError } from "./errors.js";

export const TOOL_CALL_PHASES = [
  "call_recorded",
  "capability_resolved",
  "policy_resolved",
  "approval_resolved",
  "lease_acquired",
  "checkpoint_durable",
  "started_durable",
  "executing",
  "observed",
  "result_durable",
  "terminal",
] as const;

export type ToolCallPhase = (typeof TOOL_CALL_PHASES)[number];

export type ToolCallPhaseResolution = (
  | { phase: ToolCallPhase; status: "completed" }
  | { phase: ToolCallPhase; status: "skipped" | "failed"; reason: string }
) & { result?: Partial<ToolCallResultAxes> };

export type ExecutionOutcome = "not_invoked" | "returned" | "threw" | "timed_out" | "aborted";
export type EffectState = "not_started" | "started" | "committed" | "unknown";
export type PersistenceState = "pending" | "durable" | "failed" | "unknown";
export type CleanupState = "not_needed" | "pending" | "quiescent" | "failed";
export type AuthorizationState = "pending" | "allowed" | "approved" | "denied" | "expired";
export type EnvironmentState = "available" | "degraded" | "unavailable";

export interface ToolCallResultAxes {
  executionOutcome: ExecutionOutcome;
  effectState: EffectState;
  persistenceState: PersistenceState;
  recoveryDisposition: RecoveryDisposition;
  cleanupState: CleanupState;
  authorizationState: AuthorizationState;
  environmentState: EnvironmentState;
}

export interface ToolCallLifecycleState {
  version: 1;
  agent: string;
  callId: string;
  tool: string;
  stepId?: string;
  currentPhase: ToolCallPhase;
  terminal: boolean;
  phases: ToolCallPhaseResolution[];
  result: ToolCallResultAxes;
}

export interface ToolCallLifecycleFact {
  type: "tool_lifecycle";
  agent: string;
  callId: string;
  tool: string;
  stepId?: string;
  turnId?: string;
  resolution: ToolCallPhaseResolution;
}

export interface ToolCallIdentity {
  agent: string;
  callId: string;
  stepId?: string;
}

export interface ToolExecutionEngineOptions {
  persist: (fact: ToolCallLifecycleFact) => Promise<void>;
}

const RESULT_AXES_BY_PHASE: Readonly<Record<ToolCallPhase, readonly (keyof ToolCallResultAxes)[]>> =
  {
    call_recorded: [],
    capability_resolved: ["recoveryDisposition", "environmentState"],
    policy_resolved: ["authorizationState"],
    approval_resolved: ["authorizationState"],
    lease_acquired: ["environmentState"],
    checkpoint_durable: [],
    started_durable: ["effectState", "cleanupState"],
    executing: ["environmentState"],
    observed: ["executionOutcome", "effectState", "cleanupState", "environmentState"],
    result_durable: ["persistenceState"],
    terminal: ["cleanupState"],
  };

export function createToolCallLifecycle(
  input: ToolCallIdentity & { tool: string },
): ToolCallLifecycleState {
  if (
    !isNonBlankString(input.agent) ||
    !isNonBlankString(input.callId) ||
    !isNonBlankString(input.tool) ||
    (input.stepId !== undefined && !isNonBlankString(input.stepId))
  ) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      "Tool Call 身份、可选 Step 与工具必须为非空字符串",
    );
  }
  return {
    version: 1,
    agent: input.agent,
    callId: input.callId,
    tool: input.tool,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    currentPhase: "call_recorded",
    terminal: false,
    phases: [{ phase: "call_recorded", status: "completed" }],
    result: {
      executionOutcome: "not_invoked",
      effectState: "not_started",
      persistenceState: "pending",
      recoveryDisposition: "requires_human",
      cleanupState: "not_needed",
      authorizationState: "pending",
      environmentState: "available",
    },
  };
}

export function advanceToolCallLifecycle(
  state: ToolCallLifecycleState,
  resolution: ToolCallPhaseResolution,
): ToolCallLifecycleState {
  const currentIndex = TOOL_CALL_PHASES.indexOf(state.currentPhase);
  const expectedPhase = TOOL_CALL_PHASES[currentIndex + 1];
  if (resolution.phase !== expectedPhase) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      `Call ${state.callId} 当前阶段 ${state.currentPhase} 只能推进到 ${expectedPhase ?? "无"}`,
    );
  }
  if (resolution.status !== "completed" && resolution.reason.trim().length === 0) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      `Call ${state.callId} 的 ${resolution.status} 阶段 ${resolution.phase} 缺少原因`,
    );
  }
  if (resolution.phase === "terminal" && resolution.status !== "completed") {
    throw new CoreMindError("tool_lifecycle_invalid", `Call ${state.callId} 的 terminal 必须完成`);
  }
  const unexpectedResultAxis = Object.keys(resolution.result ?? {}).find(
    (axis) => !RESULT_AXES_BY_PHASE[resolution.phase].includes(axis as keyof ToolCallResultAxes),
  );
  if (unexpectedResultAxis) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      `Call ${state.callId} 的 ${resolution.phase} 不能更新 ${unexpectedResultAxis}`,
    );
  }
  const nextEffectState = resolution.result?.effectState;
  if (nextEffectState && !canTransitionEffectState(state.result.effectState, nextEffectState)) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      `Call ${state.callId} 的 EffectState 不能从 ${state.result.effectState} 迁移到 ${nextEffectState}`,
    );
  }
  const nextExecutionOutcome = resolution.result?.executionOutcome;
  if (
    nextExecutionOutcome &&
    state.result.executionOutcome !== "not_invoked" &&
    nextExecutionOutcome !== state.result.executionOutcome
  ) {
    throw new CoreMindError(
      "tool_lifecycle_invalid",
      `Call ${state.callId} 的 ExecutionOutcome 不能从 ${state.result.executionOutcome} 迁移到 ${nextExecutionOutcome}`,
    );
  }
  return {
    ...state,
    currentPhase: resolution.phase,
    terminal: resolution.phase === "terminal",
    phases: [...state.phases, resolution],
    result: { ...state.result, ...resolution.result },
  };
}

/** 所有 Call 入口共用的生命周期写入与投影 seam。 */
export class ToolExecutionEngine {
  private readonly states = new Map<string, ToolCallLifecycleState>();
  private readonly pendingByCall = new Map<string, Promise<void>>();
  private readonly adapterInvoked = new Set<string>();

  constructor(private readonly options: ToolExecutionEngineOptions) {}

  async recordCall(input: ToolCallIdentity & { tool: string }): Promise<ToolCallLifecycleState> {
    const callKey = lifecycleCallKey(input);
    const previous = this.pendingByCall.get(callKey) ?? Promise.resolve();
    const task = previous.then(() => this.recordCallUnqueued(input));
    return this.trackPending(callKey, task);
  }

  private async recordCallUnqueued(
    input: ToolCallIdentity & { tool: string },
  ): Promise<ToolCallLifecycleState> {
    const state = createToolCallLifecycle(input);
    const callKey = lifecycleCallKey(state);
    if (this.states.has(callKey)) {
      throw new CoreMindError("tool_lifecycle_invalid", `Call ${callKey} 已记录`);
    }
    await this.options.persist({
      type: "tool_lifecycle",
      agent: state.agent,
      callId: state.callId,
      tool: state.tool,
      ...(state.stepId ? { stepId: state.stepId } : {}),
      resolution: state.phases[0]!,
    });
    this.states.set(callKey, state);
    return structuredClone(state);
  }

  async advance(
    identity: ToolCallIdentity,
    resolution: ToolCallPhaseResolution,
  ): Promise<ToolCallLifecycleState> {
    const callKey = lifecycleCallKey(identity);
    const previous = this.pendingByCall.get(callKey) ?? Promise.resolve();
    const task = previous.then(() => this.advanceUnqueued(identity, resolution));
    return this.trackPending(callKey, task);
  }

  /** 唯一 Tool Adapter 调用入口：只有已完成 executing 门禁的 Call 可执行一次。 */
  async executeAdapter<T>(identity: ToolCallIdentity, execute: () => Promise<T> | T): Promise<T> {
    const callKey = lifecycleCallKey(identity);
    const state = this.states.get(callKey);
    const currentResolution = state?.phases.at(-1);
    if (
      !state ||
      state.terminal ||
      state.currentPhase !== "executing" ||
      currentResolution?.phase !== "executing" ||
      currentResolution.status !== "completed"
    ) {
      throw new CoreMindError(
        "tool_lifecycle_invalid",
        `Call ${callKey} 未通过 executing 门禁，不得调用 Tool Adapter`,
      );
    }
    if (this.adapterInvoked.has(callKey)) {
      throw new CoreMindError(
        "tool_lifecycle_invalid",
        `Call ${callKey} 的 Tool Adapter 已调用，不得重入或自动重试`,
      );
    }
    // 在 await 前预留唯一调用权；即使 Adapter 抛错，也不能假定 Effect 未发生并重试。
    this.adapterInvoked.add(callKey);
    return execute();
  }

  private async trackPending<T>(callKey: string, task: Promise<T>): Promise<T> {
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.pendingByCall.set(callKey, tail);
    return task.finally(() => {
      if (this.pendingByCall.get(callKey) === tail) this.pendingByCall.delete(callKey);
    });
  }

  async blockBeforeExecution(
    identity: ToolCallIdentity,
    reason: string,
  ): Promise<ToolCallLifecycleState> {
    let current = this.inspect(identity);
    if (!current) {
      throw new CoreMindError(
        "tool_lifecycle_invalid",
        `Call ${lifecycleCallKey(identity)} 尚未记录`,
      );
    }
    while (current.currentPhase !== "observed") {
      const nextPhase = TOOL_CALL_PHASES[TOOL_CALL_PHASES.indexOf(current.currentPhase) + 1];
      if (!nextPhase || nextPhase === "result_durable" || nextPhase === "terminal") {
        throw new CoreMindError(
          "tool_lifecycle_invalid",
          `Call ${current.callId} 已越过执行前阻断边界`,
        );
      }
      current = await this.advance(identity, {
        phase: nextPhase,
        status: "skipped",
        reason,
        ...(nextPhase === "observed"
          ? {
              result: {
                executionOutcome: "not_invoked" as const,
                effectState: "not_started" as const,
                cleanupState: "not_needed" as const,
              },
            }
          : {}),
      });
    }
    return current;
  }

  /** 在 Tool Result 已落盘后收敛正常 Call。 */
  async finalizeResult(identity: ToolCallIdentity): Promise<ToolCallLifecycleState> {
    let current = await this.advance(identity, {
      phase: "result_durable",
      status: "completed",
      result: { persistenceState: "durable" },
    });
    current = await this.advance(identity, {
      phase: "terminal",
      status: "completed",
      result: {
        cleanupState: current.result.cleanupState === "pending" ? "pending" : "not_needed",
      },
    });
    return current;
  }

  /** Tool 已返回但结果 barrier 失败：保留执行与 Effect 事实，只收敛持久化失败。 */
  async failResultDurability(
    identity: ToolCallIdentity,
    reason: string,
  ): Promise<ToolCallLifecycleState> {
    let current = await this.advance(identity, {
      phase: "result_durable",
      status: "failed",
      reason,
      result: { persistenceState: "failed" },
    });
    current = await this.advance(identity, {
      phase: "terminal",
      status: "completed",
      result: {
        cleanupState: current.result.cleanupState === "pending" ? "pending" : "not_needed",
      },
    });
    return current;
  }

  /** 在 Run 取消或超时时，把所有开放 Call 收敛为单一、不可改写的终态。 */
  async settleInterrupted(
    executionOutcome: Extract<ExecutionOutcome, "aborted" | "timed_out">,
    reason: string,
  ): Promise<void> {
    const identities = [...this.states.values()]
      .filter((state) => !state.terminal)
      .map((state) => ({
        agent: state.agent,
        callId: state.callId,
        ...(state.stepId ? { stepId: state.stepId } : {}),
      }));
    await Promise.all(
      identities.map((identity) => this.settleOneInterrupted(identity, executionOutcome, reason)),
    );
  }

  private async settleOneInterrupted(
    identity: ToolCallIdentity,
    executionOutcome: Extract<ExecutionOutcome, "aborted" | "timed_out">,
    reason: string,
  ): Promise<void> {
    let current = this.inspect(identity);
    if (!current || current.terminal) return;
    while (current.currentPhase !== "observed") {
      const nextPhase = TOOL_CALL_PHASES[TOOL_CALL_PHASES.indexOf(current.currentPhase) + 1];
      if (!nextPhase || nextPhase === "result_durable" || nextPhase === "terminal") break;
      current = await this.advance(identity, {
        phase: nextPhase,
        ...(nextPhase === "observed"
          ? {
              status: "completed" as const,
              result: {
                executionOutcome,
                effectState:
                  current.result.effectState === "started"
                    ? ("unknown" as const)
                    : current.result.effectState,
              },
            }
          : { status: "skipped" as const, reason }),
      });
    }
    current = this.inspect(identity);
    if (!current || current.terminal) return;
    if (current.currentPhase === "observed") await this.finalizeResult(identity);
  }

  private async advanceUnqueued(
    identity: ToolCallIdentity,
    resolution: ToolCallPhaseResolution,
  ): Promise<ToolCallLifecycleState> {
    const callKey = lifecycleCallKey(identity);
    const current = this.states.get(callKey);
    if (!current) {
      throw new CoreMindError("tool_lifecycle_invalid", `Call ${callKey} 尚未记录`);
    }
    const next = advanceToolCallLifecycle(current, resolution);
    await this.options.persist({
      type: "tool_lifecycle",
      agent: current.agent,
      callId: current.callId,
      tool: current.tool,
      ...(current.stepId ? { stepId: current.stepId } : {}),
      resolution,
    });
    this.states.set(callKey, next);
    return structuredClone(next);
  }

  inspect(identity: ToolCallIdentity): ToolCallLifecycleState | undefined {
    const state = this.states.get(lifecycleCallKey(identity));
    return state ? structuredClone(state) : undefined;
  }
}

export function projectToolCallLifecycles(facts: readonly unknown[]): ToolCallLifecycleState[] {
  const states = new Map<string, ToolCallLifecycleState>();
  for (const value of facts) {
    const fact = validateToolCallLifecycleFact(value);
    const callKey = lifecycleCallKey(fact);
    const current = states.get(callKey);
    if (fact.resolution.phase === "call_recorded") {
      if (current || fact.resolution.status !== "completed") {
        throw new CoreMindError(
          "tool_lifecycle_invalid",
          `Call ${callKey} 包含重复或非法的 call_recorded Fact`,
        );
      }
      states.set(callKey, createToolCallLifecycle(fact));
      continue;
    }
    if (!current) {
      throw new CoreMindError(
        "tool_lifecycle_invalid",
        `Call ${callKey} 的 ${fact.resolution.phase} 缺少 call_recorded 前缀`,
      );
    }
    if (current.tool !== fact.tool) {
      throw new CoreMindError(
        "tool_lifecycle_invalid",
        `Call ${callKey} 的工具不能从 ${current.tool} 变更为 ${fact.tool}`,
      );
    }
    states.set(callKey, advanceToolCallLifecycle(current, fact.resolution));
  }
  return [...states.values()].map((state) => structuredClone(state));
}

export function validateToolCallLifecycleFact(value: unknown): ToolCallLifecycleFact {
  if (value === null || typeof value !== "object") {
    throw new CoreMindError("tool_lifecycle_invalid", "Tool lifecycle Fact 必须是对象");
  }
  const fact = value as Partial<ToolCallLifecycleFact>;
  const resolution = fact.resolution as Record<string, unknown> | undefined;
  const result = resolution?.result as Record<string, unknown> | undefined;
  if (
    fact.type !== "tool_lifecycle" ||
    !isNonBlankString(fact.agent) ||
    !isNonBlankString(fact.callId) ||
    !isNonBlankString(fact.tool) ||
    (fact.stepId !== undefined && !isNonBlankString(fact.stepId)) ||
    (fact.turnId !== undefined && !isNonBlankString(fact.turnId)) ||
    !resolution ||
    !TOOL_CALL_PHASES.includes(resolution.phase as ToolCallPhase) ||
    !["completed", "skipped", "failed"].includes(String(resolution.status)) ||
    (resolution.status !== "completed" && !isNonBlankString(resolution.reason)) ||
    (resolution.phase === "call_recorded" && resolution.status !== "completed") ||
    (resolution.phase === "terminal" && resolution.status !== "completed") ||
    !isValidResultPatch(result) ||
    (result !== undefined &&
      Object.keys(result).some(
        (axis) =>
          !RESULT_AXES_BY_PHASE[resolution.phase as ToolCallPhase].includes(
            axis as keyof ToolCallResultAxes,
          ),
      ))
  ) {
    throw new CoreMindError("tool_lifecycle_invalid", "Tool lifecycle Fact 合同无效");
  }
  return fact as ToolCallLifecycleFact;
}

function isValidResultPatch(result: Record<string, unknown> | undefined): boolean {
  if (result === undefined) return true;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const knownAxes = new Set(Object.values(RESULT_AXES_BY_PHASE).flat());
  return (
    Object.keys(result).every((axis) => knownAxes.has(axis as keyof ToolCallResultAxes)) &&
    isOptionalMember(result.executionOutcome, [
      "not_invoked",
      "returned",
      "threw",
      "timed_out",
      "aborted",
    ]) &&
    isOptionalMember(result.effectState, ["not_started", "started", "committed", "unknown"]) &&
    isOptionalMember(result.persistenceState, ["pending", "durable", "failed", "unknown"]) &&
    isOptionalMember(result.recoveryDisposition, [
      "replay_safe",
      "requires_proof",
      "requires_human",
      "forbidden",
    ]) &&
    isOptionalMember(result.cleanupState, ["not_needed", "pending", "quiescent", "failed"]) &&
    isOptionalMember(result.authorizationState, [
      "pending",
      "allowed",
      "approved",
      "denied",
      "expired",
    ]) &&
    isOptionalMember(result.environmentState, ["available", "degraded", "unavailable"])
  );
}

function isOptionalMember(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === "string" && allowed.includes(value));
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function lifecycleCallKey(identity: ToolCallIdentity): string {
  return `${identity.agent}:${identity.stepId ?? "-"}:${identity.callId}`;
}

function canTransitionEffectState(previous: EffectState, next: EffectState): boolean {
  switch (previous) {
    case "not_started":
      return true;
    case "started":
      return next === "started" || next === "committed" || next === "unknown";
    case "committed":
      return next === "committed";
    case "unknown":
      return next === "unknown";
  }
}
