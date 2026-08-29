import { createHash } from "node:crypto";
import { tightenExecutionEnvironmentRequirement } from "coremind-tools/internal";
import { canonicalJson } from "./canonical-json.js";
import {
  isResolvedDelegatedContextReference,
  type ResolvedDelegatedContextReference,
} from "./delegated-context.js";
import { CoreMindError, terminalStatusForCode } from "./errors.js";
import { normalizeExecutionError } from "./execution-error.js";
import type { RunOutcome } from "./result.js";
import type { RunStateJournal, RunStateRecord, RunStore } from "./run-state.js";
import { redactSensitiveText } from "./trace.js";

export const CHILD_RUN_LIMIT_DEFAULTS = Object.freeze({
  maxDepth: 3,
  maxActiveChildren: 4,
  maxDescendants: 32,
});

const DEFAULT_BUDGET_SCOPE = "__default__";

export interface ChildRunBudgetAllocation {
  tokens: number;
  toolCalls: number;
  costUsd: number;
  wallTimeMs: number;
  steps: number;
  descendants: number;
}

export interface ChildRunEnvironmentRequirement {
  isolation?: "sandbox";
  readAccess?: "workspace" | "none";
  writeAccess?: "workspace" | "none";
  outsideWorkspaceAccess?: "blocked";
  networkEgress?: "controlled" | "denied";
  credentialIsolation?: "environment" | "environment_and_files";
  processControl?: "process" | "process_tree";
  termination?: {
    kill?: "process" | "process_tree";
    timeout?: boolean;
    pty?: boolean;
  };
  durability?: "critical";
}

export interface ChildRunPermissionSnapshot {
  mode: "ask" | "assisted" | "full";
  workspaceOnly: boolean;
  network: "ask" | "allow" | "deny";
  tools: readonly string[];
  paths: readonly string[];
  credentials: readonly string[];
}

export interface ChildRunPolicySnapshot {
  depth: number;
  budget: ChildRunBudgetAllocation;
  permissions: ChildRunPermissionSnapshot;
  environment: ChildRunEnvironmentRequirement;
  model: ChildRunModelSnapshot;
  workspace: ChildRunWorkspaceSnapshot;
  protectedContextReferences: readonly string[];
  protectedContextResolvedReferences?: readonly ResolvedDelegatedContextReference[];
  /** 按父 Agent 预算作用域固定的命名 Delegation Target 路由。 */
  delegationModelRoutes?: Readonly<Record<string, Readonly<Record<string, ChildRunModelSnapshot>>>>;
  maxDepth?: number;
  maxActiveChildren?: number;
  maxDescendants?: number;
}

export interface ChildRunHierarchyLimits {
  maxDepth?: number;
  maxActiveChildren?: number;
}

export interface ChildRunCoordinatorHierarchyLimits {
  maxDepth: number;
  maxActiveChildren: number;
  maxDescendants: number;
}

export interface ChildRunContextReference {
  workingSetFingerprint: string;
  references: readonly string[];
  resolvedReferences?: readonly ResolvedDelegatedContextReference[];
}

export interface ChildRunModelSnapshot {
  providerId: string;
  model: string;
  providerConfigFingerprint: string;
  agentPromptFingerprint: string;
  agentDelegationFingerprint: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh";
  };
}

export interface ChildRunWorkspaceSnapshot {
  canonicalRoot: string;
  lease: "shared_canonical";
}

export interface ChildRunLifecyclePolicy {
  join: "structured";
  cancel: "propagate_parent";
  orphan: "audit_pause";
  detach: "forbidden" | "durable_preaccepted";
}

export interface ChildRunDelegationRequest {
  delegationId: string;
  budgetScope?: string;
  parentTurnId: string;
  parentStepId: string;
  agentName: string;
  task: string;
  model: ChildRunModelSnapshot;
  workspace: ChildRunWorkspaceSnapshot;
  lifecyclePolicy: ChildRunLifecyclePolicy;
  context: ChildRunContextReference;
  allocation: ChildRunBudgetAllocation;
  hierarchyLimits?: ChildRunHierarchyLimits;
  permissions: ChildRunPermissionSnapshot;
  environment: ChildRunEnvironmentRequirement;
}

export interface ChildRunResult {
  outcome: RunOutcome;
  evidence: readonly string[];
  artifacts: readonly string[];
  workspaceChanges: readonly string[];
  unresolvedRisks: readonly string[];
}

export interface ChildRunExecutionInput {
  parentRunId: string;
  childRunId: string;
  delegationId: string;
  inputFingerprint: string;
  request: ChildRunDelegationRequest;
  inheritedPolicy: ChildRunPolicySnapshot;
  signal: AbortSignal;
}

export interface ChildRunExecutionAdapter {
  execute(input: ChildRunExecutionInput): Promise<ChildRunResult>;
}

export interface ChildRunHandle {
  readonly parentRunId: string;
  readonly childRunId: string;
  readonly delegationId: string;
  readonly inputFingerprint: string;
  cancel(reason?: string): Promise<void>;
  join(options?: ChildRunJoinOptions): Promise<ChildRunResult>;
}

export interface ChildRunJoinOptions {
  timeoutMs?: number;
}

export type ChildRunFact =
  | {
      type: "delegation_recorded";
      parentRunId: string;
      childRunId: string;
      delegationId: string;
      budgetScope?: string;
      parentTurnId: string;
      parentStepId: string;
      inputFingerprint: string;
      agentName: string;
      model: ChildRunModelSnapshot;
      workspace: ChildRunWorkspaceSnapshot;
      lifecyclePolicy: ChildRunLifecyclePolicy;
      context: ChildRunContextReference;
      inheritedPolicy: ChildRunPolicySnapshot;
      requestedAllocation: ChildRunBudgetAllocation;
      requestedPermissions: ChildRunPermissionSnapshot;
      requestedEnvironment: ChildRunEnvironmentRequirement;
      recordedAt: string;
    }
  | ChildRunLifecycleFact;

export type ChildRunLifecycleFact =
  | ChildRunIdentityFact<"child_created">
  | ChildRunIdentityFact<"child_running">
  | (ChildRunIdentityFact<"child_cancel_requested"> & {
      requestedBy: "parent" | "child" | "join_timeout";
      reason: string;
    })
  | (ChildRunIdentityFact<"child_terminal"> & { result: ChildRunResult })
  | (ChildRunIdentityFact<"child_paused"> & { result: ChildRunResult })
  | (ChildRunIdentityFact<"child_orphaned"> & { result: ChildRunResult })
  | (ChildRunIdentityFact<"parent_joined"> & { result: ChildRunResult });

interface ChildRunIdentityFact<TType extends string> {
  type: TType;
  parentRunId: string;
  childRunId: string;
  delegationId: string;
  budgetScope?: string;
  inputFingerprint: string;
  recordedAt: string;
}

export interface ChildRunCoordinatorOptions {
  parentRunId: string;
  parentJournal: RunStateJournal;
  runStore: RunStore;
  parentPolicy: ChildRunPolicySnapshot;
  delegationBudgetPools?: Readonly<Record<string, ChildRunBudgetAllocation>>;
  delegationHierarchyLimits?: Readonly<Record<string, ChildRunCoordinatorHierarchyLimits>>;
  adapter: ChildRunExecutionAdapter;
  createChildRunId: () => string;
  reserveParentBudget?: (allocation: ChildRunBudgetAllocation) => () => void;
  cancellationGraceMs?: number;
  now?: () => string;
}

export type ChildRunPersistedLifecycleStatus =
  | "recorded"
  | "created"
  | "running"
  | "terminal"
  | "paused"
  | "orphaned"
  | "joined";

interface DelegationState {
  childRunId: string;
  delegationId: string;
  budgetScope?: string;
  inputFingerprint: string;
  status: ChildRunPersistedLifecycleStatus | "terminalizing";
  result?: ChildRunResult;
  abortController?: AbortController;
  cancellationFinishReason?: "parent_cancelled" | "child_cancelled" | "child_join_timeout";
  completion?: Promise<ChildRunResult>;
  initialization?: Promise<void>;
  releaseParentBudget?: () => void;
  joinPromise?: Promise<ChildRunResult>;
}

/**
 * Child Run 深模块：把幂等身份、持久生命周期和结构化 join 隐藏在一个委派接口后。
 * 实际子运行由 Adapter 执行；父 Run 只保存关系与结构化结果，不复制子级消息或 Receipt。
 */
export class ChildRunCoordinator {
  private readonly delegations = new Map<string, DelegationState>();
  private readonly now: () => string;
  private readonly remainingBudgets = new Map<string, ChildRunBudgetAllocation>();
  private readonly hierarchyLimits = new Map<string, ChildRunCoordinatorHierarchyLimits>();
  private readonly parentPolicy: NormalizedChildRunPolicySnapshot;

  private constructor(private readonly options: ChildRunCoordinatorOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.parentPolicy = normalizeParentPolicy(options.parentPolicy);
    const configuredPools = Object.entries(options.delegationBudgetPools ?? {});
    if (configuredPools.length === 0) {
      this.remainingBudgets.set(DEFAULT_BUDGET_SCOPE, structuredClone(this.parentPolicy.budget));
      this.hierarchyLimits.set(DEFAULT_BUDGET_SCOPE, hierarchyFromPolicy(this.parentPolicy));
    } else {
      for (const [scope, budget] of configuredPools) {
        if (scope.length === 0) throw policyEscalation("Delegation Budget 作用域不能为空");
        assertDelegationBudgetPool(this.parentPolicy, budget);
        this.remainingBudgets.set(scope, structuredClone(budget));
        this.hierarchyLimits.set(
          scope,
          normalizeScopeHierarchy(
            this.parentPolicy,
            budget,
            options.delegationHierarchyLimits?.[scope],
          ),
        );
      }
      const unknownHierarchyScope = Object.keys(options.delegationHierarchyLimits ?? {}).find(
        (scope) => !this.remainingBudgets.has(scope),
      );
      if (unknownHierarchyScope) {
        throw policyEscalation(`Delegation 层级作用域 ${unknownHierarchyScope} 没有匹配的预算池`);
      }
    }
  }

  static async open(options: ChildRunCoordinatorOptions): Promise<ChildRunCoordinator> {
    if (options.parentJournal.runId !== options.parentRunId) {
      throw new CoreMindError(
        "child_run_parent_mismatch",
        "Child Run Coordinator 的父 Run 身份不一致",
      );
    }
    const coordinator = new ChildRunCoordinator(options);
    coordinator.restore(await options.runStore.read(options.parentRunId));
    await coordinator.auditRestoredOrphans();
    return coordinator;
  }

  async delegate(request: ChildRunDelegationRequest): Promise<ChildRunHandle> {
    const requestSnapshot = deepFreeze(structuredClone(request));
    const inputFingerprint = childRunInputFingerprint(requestSnapshot);
    const existing = this.delegations.get(requestSnapshot.delegationId);
    if (existing) {
      if (existing.inputFingerprint !== inputFingerprint) {
        throw new CoreMindError(
          "delegation_conflict",
          `DelegationId ${requestSnapshot.delegationId} 已绑定不同输入`,
        );
      }
      return this.handleFor(existing);
    }

    const scope = this.scopeFor(requestSnapshot.budgetScope);
    this.assertActiveChildLimit(scope.key, scope.hierarchy.maxActiveChildren);
    const scopedParentPolicy = { ...this.parentPolicy, ...scope.hierarchy };
    assertChildRunPolicyIsNarrower(scopedParentPolicy, scope.remainingBudget, requestSnapshot);
    const childPolicy = effectiveChildPolicy(scopedParentPolicy, requestSnapshot);
    const releaseParentBudget = this.options.reserveParentBudget?.(requestSnapshot.allocation);

    const childRunId = this.options.createChildRunId();
    const state: DelegationState = {
      childRunId,
      delegationId: requestSnapshot.delegationId,
      budgetScope: requestSnapshot.budgetScope,
      inputFingerprint,
      status: "recorded",
      abortController: new AbortController(),
      releaseParentBudget,
    };
    this.delegations.set(requestSnapshot.delegationId, state);
    reserveBudget(scope.remainingBudget, requestSnapshot.allocation);
    let delegationRecorded = false;
    state.initialization = (async () => {
      await this.options.parentJournal.appendFact(
        "delegation",
        {
          type: "delegation_recorded",
          parentRunId: this.options.parentRunId,
          childRunId,
          delegationId: requestSnapshot.delegationId,
          budgetScope: requestSnapshot.budgetScope,
          parentTurnId: requestSnapshot.parentTurnId,
          parentStepId: requestSnapshot.parentStepId,
          inputFingerprint,
          agentName: requestSnapshot.agentName,
          model: requestSnapshot.model,
          workspace: requestSnapshot.workspace,
          lifecyclePolicy: requestSnapshot.lifecyclePolicy,
          context: requestSnapshot.context,
          inheritedPolicy: childPolicy,
          requestedAllocation: requestSnapshot.allocation,
          requestedPermissions: requestSnapshot.permissions,
          requestedEnvironment: requestSnapshot.environment,
          recordedAt: this.now(),
        } satisfies ChildRunFact,
        { durability: "critical" },
      );
      delegationRecorded = true;
      await this.appendLifecycle(state, "child_created", "critical");
      state.completion = this.execute(state, requestSnapshot, childPolicy);
    })();
    try {
      await state.initialization;
      return this.handleFor(state);
    } catch (error) {
      const definitelyNotRecorded =
        !delegationRecorded &&
        (await this.isDelegationDefinitelyAbsent(requestSnapshot.delegationId));
      if (definitelyNotRecorded) {
        this.delegations.delete(requestSnapshot.delegationId);
        releaseBudget(scope.remainingBudget, requestSnapshot.allocation);
        state.releaseParentBudget?.();
      }
      throw error;
    }
  }

  private async isDelegationDefinitelyAbsent(delegationId: string): Promise<boolean> {
    try {
      const records = await this.options.runStore.read(this.options.parentRunId);
      return !records.some(
        (record) =>
          record.kind === "delegation" &&
          isRecord(record.payload) &&
          record.payload.delegationId === delegationId,
      );
    } catch {
      return false;
    }
  }

  async cancelAll(reason: string): Promise<void> {
    const active = [...this.delegations.values()].filter((state) => state.status !== "joined");
    await Promise.all(
      active.map(async (state) => {
        await this.cancelState(state, "parent", reason, "parent_cancelled", false);
        await this.join(state);
      }),
    );
  }

  isQuiescent(): boolean {
    return [...this.delegations.values()].every((state) => state.status === "joined");
  }

  private async execute(
    state: DelegationState,
    request: ChildRunDelegationRequest,
    childPolicy: ChildRunPolicySnapshot,
  ): Promise<ChildRunResult> {
    await this.appendLifecycle(state, "child_running", "ordinary");
    const signal = state.abortController?.signal ?? AbortSignal.abort("Child Run 执行所有权已丢失");
    let result: ChildRunResult;
    if (signal.aborted) {
      result = cancellationResult(state.cancellationFinishReason ?? "parent_cancelled");
    } else {
      try {
        const executionInput = Object.freeze({
          parentRunId: this.options.parentRunId,
          childRunId: state.childRunId,
          delegationId: state.delegationId,
          inputFingerprint: state.inputFingerprint,
          request: deepFreeze(structuredClone(request)),
          inheritedPolicy: deepFreeze(structuredClone(childPolicy)),
          signal,
        });
        result = normalizeChildRunResult(await this.options.adapter.execute(executionInput));
      } catch (error) {
        result = signal.aborted
          ? cancellationResult(state.cancellationFinishReason ?? "parent_cancelled")
          : adapterFailureResult(error);
      }
    }
    state.status = "terminalizing";
    const terminalFact = result.outcome.status === "paused" ? "child_paused" : "child_terminal";
    await this.options.parentJournal.appendFact(
      "delegation",
      this.lifecycleFact(state, terminalFact, { result }),
      { durability: "critical" },
    );
    state.status = terminalFact === "child_paused" ? "paused" : "terminal";
    state.result = structuredClone(result);
    return structuredClone(result);
  }

  private handleFor(state: DelegationState): ChildRunHandle {
    return Object.freeze({
      parentRunId: this.options.parentRunId,
      childRunId: state.childRunId,
      delegationId: state.delegationId,
      inputFingerprint: state.inputFingerprint,
      cancel: (reason?: string) =>
        this.cancelState(state, "child", reason ?? "Child Run 已取消", "child_cancelled"),
      join: (options?: ChildRunJoinOptions) => this.join(state, options),
    });
  }

  private assertActiveChildLimit(scope: string, maxActiveChildren: number): void {
    const active = [...this.delegations.values()].filter(
      (state) =>
        (state.budgetScope ?? DEFAULT_BUDGET_SCOPE) === scope &&
        (state.status === "recorded" || state.status === "created" || state.status === "running"),
    ).length;
    if (active >= maxActiveChildren) {
      throw new CoreMindError(
        "child_run_concurrency_limit",
        `父 Run 的活动 Child Run 已达到上限 ${maxActiveChildren}`,
      );
    }
  }

  private scopeFor(scope: string | undefined): {
    key: string;
    remainingBudget: ChildRunBudgetAllocation;
    hierarchy: ChildRunCoordinatorHierarchyLimits;
  } {
    const key = scope ?? DEFAULT_BUDGET_SCOPE;
    const remainingBudget = this.remainingBudgets.get(key);
    const hierarchy = this.hierarchyLimits.get(key);
    if (!remainingBudget || !hierarchy) {
      throw policyEscalation(`父 Agent ${scope ?? "default"} 没有可用的 Delegation Budget 池`);
    }
    return { key, remainingBudget, hierarchy };
  }

  private remainingBudgetFor(scope: string | undefined): ChildRunBudgetAllocation {
    return this.scopeFor(scope).remainingBudget;
  }

  private async auditRestoredOrphans(): Promise<void> {
    const orphaned = [...this.delegations.values()].filter(
      (state) =>
        state.status === "recorded" || state.status === "created" || state.status === "running",
    );
    for (const state of orphaned) {
      const result = orphanedResult(state.childRunId);
      await this.options.parentJournal.appendFact(
        "delegation",
        this.lifecycleFact(state, "child_orphaned", { result }),
        { durability: "critical" },
      );
      state.status = "orphaned";
      state.result = structuredClone(result);
    }
  }

  private join(state: DelegationState, options?: ChildRunJoinOptions): Promise<ChildRunResult> {
    if (state.joinPromise) return state.joinPromise;
    state.joinPromise = (async () => {
      if (state.status === "joined" && state.result) return structuredClone(state.result);
      await state.initialization;
      if (
        (state.status === "terminal" || state.status === "paused" || state.status === "orphaned") &&
        state.result
      ) {
        const result = structuredClone(state.result);
        await this.options.parentJournal.appendFact(
          "delegation",
          this.lifecycleFact(state, "parent_joined", { result }),
          { durability: "critical" },
        );
        state.status = "joined";
        return result;
      }
      if (!state.completion) {
        throw new CoreMindError(
          "child_run_orphan_audit_required",
          `Child Run ${state.childRunId} 没有当前进程执行所有权，必须先执行 orphan audit`,
        );
      }
      let result: ChildRunResult;
      if (options?.timeoutMs !== undefined && options.timeoutMs >= 0) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = Symbol("child-run-join-timeout");
        const settled = await Promise.race([
          state.completion,
          new Promise<typeof timeout>((resolve) => {
            timer = setTimeout(() => resolve(timeout), options.timeoutMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        if (settled === timeout) {
          await this.cancelState(
            state,
            "join_timeout",
            `Child Run ${state.childRunId} join 超时`,
            "child_join_timeout",
            false,
          );
          const cancellationGraceMs = this.options.cancellationGraceMs ?? 5_000;
          const afterCancellation = await Promise.race([
            state.completion,
            new Promise<typeof timeout>((resolve) => {
              timer = setTimeout(() => resolve(timeout), cancellationGraceMs);
            }),
          ]);
          if (timer) clearTimeout(timer);
          if (afterCancellation === timeout) {
            throw new CoreMindError(
              "child_run_not_quiescent",
              `Child Run ${state.childRunId} 取消后 ${cancellationGraceMs}ms 内仍未静止`,
            );
          }
          result = afterCancellation;
        } else {
          result = settled;
        }
      } else {
        result = await state.completion;
      }
      await this.options.parentJournal.appendFact(
        "delegation",
        this.lifecycleFact(state, "parent_joined", { result }),
        { durability: "critical" },
      );
      state.status = "joined";
      state.result = structuredClone(result);
      return structuredClone(result);
    })().catch((error) => {
      state.joinPromise = undefined;
      throw error;
    });
    return state.joinPromise;
  }

  private async cancelState(
    state: DelegationState,
    requestedBy: "parent" | "child" | "join_timeout",
    reason: string,
    finishReason: "parent_cancelled" | "child_cancelled" | "child_join_timeout",
    awaitCompletion = true,
  ): Promise<void> {
    if (state.status !== "recorded" && state.status !== "created" && state.status !== "running") {
      return;
    }
    state.cancellationFinishReason = finishReason;
    await this.options.parentJournal.appendFact(
      "delegation",
      this.lifecycleFact(state, "child_cancel_requested", { requestedBy, reason }),
      { durability: "critical" },
    );
    state.abortController?.abort(reason);
    if (awaitCompletion && state.completion) await state.completion;
  }

  private async appendLifecycle(
    state: DelegationState,
    type: "child_created" | "child_running",
    durability: "ordinary" | "critical",
  ): Promise<void> {
    await this.options.parentJournal.appendFact("delegation", this.lifecycleFact(state, type), {
      durability,
    });
    state.status = type === "child_created" ? "created" : "running";
  }

  private lifecycleFact(
    state: DelegationState,
    type: ChildRunLifecycleFact["type"],
    extra: { result: ChildRunResult } | object = {},
  ): ChildRunLifecycleFact {
    return {
      type,
      parentRunId: this.options.parentRunId,
      childRunId: state.childRunId,
      delegationId: state.delegationId,
      ...(state.budgetScope ? { budgetScope: state.budgetScope } : {}),
      inputFingerprint: state.inputFingerprint,
      recordedAt: this.now(),
      ...extra,
    } as ChildRunLifecycleFact;
  }

  private restore(records: readonly RunStateRecord[]): void {
    for (const record of records) {
      if (record.kind !== "delegation" || !isChildRunFact(record.payload)) continue;
      const fact = record.payload;
      if (fact.parentRunId !== this.options.parentRunId) {
        throw new CoreMindError("run_state_corrupt", "Delegation Fact 的父 Run 身份不一致");
      }
      const existing = this.delegations.get(fact.delegationId);
      if (fact.type === "delegation_recorded") {
        if (existing) {
          throw new CoreMindError("run_state_corrupt", "同一 DelegationId 存在重复 recorded Fact");
        }
        const restored: DelegationState = {
          childRunId: fact.childRunId,
          delegationId: fact.delegationId,
          budgetScope: fact.budgetScope,
          inputFingerprint: fact.inputFingerprint,
          status: "recorded",
        };
        this.delegations.set(fact.delegationId, restored);
        try {
          reserveBudget(this.remainingBudgetFor(fact.budgetScope), fact.requestedAllocation);
          restored.releaseParentBudget = this.options.reserveParentBudget?.(
            fact.requestedAllocation,
          );
        } catch {
          throw new CoreMindError("run_state_corrupt", "Child Run 的累计预算划拨超过父级预算");
        }
        continue;
      }
      if (
        !existing ||
        existing.childRunId !== fact.childRunId ||
        existing.inputFingerprint !== fact.inputFingerprint
      ) {
        throw new CoreMindError(
          "run_state_corrupt",
          "Child Run 生命周期缺少匹配的 Delegation Fact",
        );
      }
      existing.status = foldChildRunLifecycleStatus(existing.status, fact.type);
      if (
        fact.type === "child_terminal" ||
        fact.type === "child_paused" ||
        fact.type === "child_orphaned" ||
        fact.type === "parent_joined"
      ) {
        existing.result = structuredClone(fact.result);
      }
    }
  }
}

export function childRunInputFingerprint(request: ChildRunDelegationRequest): string {
  const { delegationId: _delegationId, ...input } = request;
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function assertChildRunPolicyIsNarrower(
  parent: NormalizedChildRunPolicySnapshot,
  remainingBudget: ChildRunBudgetAllocation,
  request: ChildRunDelegationRequest,
): void {
  if (
    request.lifecyclePolicy.join !== "structured" ||
    request.lifecyclePolicy.cancel !== "propagate_parent" ||
    request.lifecyclePolicy.orphan !== "audit_pause" ||
    request.lifecyclePolicy.detach !== "forbidden"
  ) {
    throw policyEscalation("当前 Child Run 只支持结构化 join，尚不支持脱离父生命周期");
  }
  if (parent.depth + 1 > parent.maxDepth) {
    throw policyEscalation("Child Run 深度超过父级允许上限");
  }
  effectiveChildHierarchy(parent, request);
  const routeScope = request.budgetScope ?? DEFAULT_BUDGET_SCOPE;
  const configuredModel = parent.delegationModelRoutes?.[routeScope]?.[request.agentName];
  if (!configuredModel) {
    throw policyEscalation("Child Run 缺少命名 Delegation Target 的固定模型路由");
  }
  if (
    !matchesConfiguredDelegationModel(configuredModel, request.model, request.allocation.tokens)
  ) {
    throw policyEscalation("Child Run 模型与命名 Delegation Target 的固定路由不一致");
  }
  if (canonicalJson(request.workspace) !== canonicalJson(parent.workspace)) {
    throw policyEscalation("Child Run Workspace 身份或租约要求与父级不一致");
  }
  const requestedReferences = new Set(request.context.references);
  if (parent.protectedContextReferences.some((reference) => !requestedReferences.has(reference))) {
    throw policyEscalation("Child Run Context 缺少父级不可删除引用");
  }
  for (const key of Object.keys(parent.budget) as (keyof ChildRunBudgetAllocation)[]) {
    const requested = request.allocation[key];
    const reserved = key === "descendants" ? requested + 1 : requested;
    if (!Number.isFinite(requested) || requested < 0 || reserved > remainingBudget[key]) {
      throw policyEscalation(`Child Run 的 ${key} 预算超过父级分配`);
    }
  }
  const parentPermissions = parent.permissions;
  const requestedPermissions = request.permissions;
  if (permissionModeRank(requestedPermissions.mode) < permissionModeRank(parentPermissions.mode)) {
    throw policyEscalation("Child Run 权限模式比父级更宽");
  }
  if (parentPermissions.workspaceOnly && !requestedPermissions.workspaceOnly) {
    throw policyEscalation("Child Run 不能移除父级工作区边界");
  }
  if (
    networkPermissionRank(requestedPermissions.network) <
    networkPermissionRank(parentPermissions.network)
  ) {
    throw policyEscalation("Child Run 网络权限比父级更宽");
  }
  assertSubset("工具", requestedPermissions.tools, parentPermissions.tools);
  assertSubset("路径", requestedPermissions.paths, parentPermissions.paths);
  assertSubset("凭据", requestedPermissions.credentials, parentPermissions.credentials);
  const tightenedEnvironment = tightenChildRunEnvironment(parent.environment, request.environment);
  if (canonicalJson(tightenedEnvironment) !== canonicalJson(request.environment)) {
    throw policyEscalation("Child Run 执行环境要求比父级更宽");
  }
}

type NormalizedChildRunPolicySnapshot = ChildRunPolicySnapshot & {
  maxDepth: number;
  maxActiveChildren: number;
  maxDescendants: number;
};

function normalizeParentPolicy(policy: ChildRunPolicySnapshot): NormalizedChildRunPolicySnapshot {
  const maxDepth = policy.maxDepth ?? CHILD_RUN_LIMIT_DEFAULTS.maxDepth;
  const maxActiveChildren = policy.maxActiveChildren ?? CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren;
  const maxDescendants = policy.maxDescendants ?? CHILD_RUN_LIMIT_DEFAULTS.maxDescendants;
  for (const [label, value] of [
    ["depth", policy.depth],
    ["maxDepth", maxDepth],
    ["maxActiveChildren", maxActiveChildren],
    ["maxDescendants", maxDescendants],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw policyEscalation(`Child Run 的 ${label} 必须是有限非负整数`);
    }
  }
  for (const [key, value] of Object.entries(policy.budget)) {
    if (!Number.isFinite(value) || value < 0) {
      throw policyEscalation(`Child Run 父级 ${key} 预算必须是有限非负数`);
    }
  }
  if (policy.budget.descendants > maxDescendants) {
    throw policyEscalation("Child Run 父级后代预算超过 maxDescendants");
  }
  return {
    ...structuredClone(policy),
    maxDepth,
    maxActiveChildren,
    maxDescendants,
  };
}

function assertDelegationBudgetPool(
  parent: NormalizedChildRunPolicySnapshot,
  budget: ChildRunBudgetAllocation,
): void {
  for (const key of Object.keys(parent.budget) as (keyof ChildRunBudgetAllocation)[]) {
    const value = budget[key];
    if (!Number.isFinite(value) || value < 0 || value > parent.budget[key]) {
      throw policyEscalation(`Delegation Budget 池的 ${key} 不能超过父 Run 预算`);
    }
  }
  if (budget.descendants > parent.maxDescendants) {
    throw policyEscalation("Delegation Budget 池的 descendants 不能超过父级后代上限");
  }
}

function hierarchyFromPolicy(
  policy: NormalizedChildRunPolicySnapshot,
): ChildRunCoordinatorHierarchyLimits {
  return {
    maxDepth: policy.maxDepth,
    maxActiveChildren: policy.maxActiveChildren,
    maxDescendants: policy.maxDescendants,
  };
}

function normalizeScopeHierarchy(
  parent: NormalizedChildRunPolicySnapshot,
  budget: ChildRunBudgetAllocation,
  configured: ChildRunCoordinatorHierarchyLimits | undefined,
): ChildRunCoordinatorHierarchyLimits {
  const maxDepth = checkedHierarchyLimit(
    "maxDepth",
    configured?.maxDepth ?? parent.maxDepth,
    parent.maxDepth,
  );
  const maxActiveChildren = checkedHierarchyLimit(
    "maxActiveChildren",
    configured?.maxActiveChildren ?? parent.maxActiveChildren,
    parent.maxActiveChildren,
  );
  const maxDescendants = checkedHierarchyLimit(
    "maxDescendants",
    configured?.maxDescendants ?? Math.min(parent.maxDescendants, budget.descendants),
    Math.min(parent.maxDescendants, budget.descendants),
  );
  return { maxDepth, maxActiveChildren, maxDescendants };
}

function effectiveChildPolicy(
  parent: NormalizedChildRunPolicySnapshot,
  request: ChildRunDelegationRequest,
): ChildRunPolicySnapshot {
  const hierarchy = effectiveChildHierarchy(parent, request);
  return {
    depth: parent.depth + 1,
    budget: structuredClone(request.allocation),
    permissions: structuredClone(request.permissions),
    environment: tightenChildRunEnvironment(parent.environment, request.environment),
    model: structuredClone(request.model),
    workspace: structuredClone(request.workspace),
    protectedContextReferences: [...new Set(request.context.references)],
    ...((request.context.resolvedReferences?.length ?? 0) > 0
      ? {
          protectedContextResolvedReferences: structuredClone(request.context.resolvedReferences),
        }
      : {}),
    ...hierarchy,
  };
}

function effectiveChildHierarchy(
  parent: NormalizedChildRunPolicySnapshot,
  request: ChildRunDelegationRequest,
): Required<ChildRunHierarchyLimits> & { maxDescendants: number } {
  const requested = request.hierarchyLimits ?? {};
  const maxDepth = checkedHierarchyLimit(
    "maxDepth",
    requested.maxDepth ?? parent.maxDepth,
    parent.maxDepth,
  );
  if (maxDepth < parent.depth + 1) {
    throw policyEscalation("Child Run 的 maxDepth 不能小于当前子级深度");
  }
  const maxActiveChildren = checkedHierarchyLimit(
    "maxActiveChildren",
    requested.maxActiveChildren ?? parent.maxActiveChildren,
    parent.maxActiveChildren,
  );
  const maxDescendants = request.allocation.descendants;
  return { maxDepth, maxActiveChildren, maxDescendants };
}

function checkedHierarchyLimit(label: string, value: number, inherited: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > inherited) {
    throw policyEscalation(`Child Run 的 ${label} 只能是有限非负整数且不能超过父级限制`);
  }
  return value;
}

function reserveBudget(
  remaining: ChildRunBudgetAllocation,
  allocation: ChildRunBudgetAllocation,
): void {
  for (const key of Object.keys(remaining) as (keyof ChildRunBudgetAllocation)[]) {
    const reserved = key === "descendants" ? allocation[key] + 1 : allocation[key];
    if (!Number.isFinite(reserved) || reserved < 0 || reserved > remaining[key]) {
      throw policyEscalation(`Child Run 的 ${key} 预算超过父级剩余预算`);
    }
    remaining[key] -= reserved;
  }
}

function releaseBudget(
  remaining: ChildRunBudgetAllocation,
  allocation: ChildRunBudgetAllocation,
): void {
  for (const key of Object.keys(remaining) as (keyof ChildRunBudgetAllocation)[]) {
    remaining[key] += key === "descendants" ? allocation[key] + 1 : allocation[key];
  }
}

function assertSubset(
  label: string,
  requested: readonly string[],
  inherited: readonly string[],
): void {
  const inheritedValues = new Set(inherited);
  if (requested.some((value) => !inheritedValues.has(value))) {
    throw policyEscalation(`Child Run ${label}集合包含父级未授权项`);
  }
}

function permissionModeRank(mode: ChildRunPermissionSnapshot["mode"]): number {
  return mode === "ask" ? 2 : mode === "assisted" ? 1 : 0;
}

function networkPermissionRank(network: ChildRunPermissionSnapshot["network"]): number {
  return network === "deny" ? 2 : network === "ask" ? 1 : 0;
}

function policyEscalation(message: string): CoreMindError {
  return new CoreMindError("child_run_policy_escalation", message);
}

function tightenChildRunEnvironment(
  inherited: ChildRunEnvironmentRequirement,
  requested: ChildRunEnvironmentRequirement,
): ChildRunEnvironmentRequirement {
  return removeUndefined(
    structuredClone(tightenExecutionEnvironmentRequirement(inherited, requested)),
  ) as ChildRunEnvironmentRequirement;
}

function removeUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)]),
  );
}

function adapterFailureResult(error: unknown): ChildRunResult {
  const normalized = normalizeExecutionError(error);
  const { code, message, audit } = normalized;
  return {
    outcome: {
      status: terminalStatusForCode(code),
      finishReason: code,
      error: { code, message, ...(audit ? { audit } : {}) },
    },
    evidence: [],
    artifacts: [],
    workspaceChanges: [],
    unresolvedRisks: [message],
  };
}

function normalizeChildRunResult(result: ChildRunResult): ChildRunResult {
  if (!isChildRunResult(result)) {
    throw new Error("Child Run Adapter 返回了无效结果");
  }
  const sanitized = {
    ...structuredClone(result),
    evidence: result.evidence.map(redactSensitiveText),
    artifacts: result.artifacts.map(redactSensitiveText),
    workspaceChanges: result.workspaceChanges.map(redactSensitiveText),
    unresolvedRisks: result.unresolvedRisks.map(redactSensitiveText),
  };
  const error =
    result.outcome.error ??
    (result.outcome.status === "succeeded" || isChildLifecycleOutcomeWithoutError(result.outcome)
      ? undefined
      : { code: result.outcome.finishReason, message: result.outcome.finishReason });
  if (!error) return sanitized;
  const normalized = normalizeExecutionError(error);
  return {
    ...sanitized,
    outcome: {
      status: terminalStatusForCode(normalized.code),
      finishReason: normalized.code,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.audit ? { audit: normalized.audit } : {}),
      },
    },
  };
}

function isChildLifecycleOutcomeWithoutError(outcome: RunOutcome): boolean {
  return (
    (outcome.status === "aborted" &&
      (outcome.finishReason === "parent_cancelled" ||
        outcome.finishReason === "child_cancelled")) ||
    (outcome.status === "timeout" && outcome.finishReason === "child_join_timeout")
  );
}

function cancellationResult(
  finishReason: "parent_cancelled" | "child_cancelled" | "child_join_timeout",
): ChildRunResult {
  return {
    outcome: {
      status: finishReason === "child_join_timeout" ? "timeout" : "aborted",
      finishReason,
    },
    evidence: [],
    artifacts: [],
    workspaceChanges: [],
    unresolvedRisks: [],
  };
}

function orphanedResult(childRunId: string): ChildRunResult {
  const message = `Child Run ${childRunId} 恢复时无法确认执行所有权，已停止自动恢复`;
  return {
    outcome: {
      status: "paused",
      finishReason: "child_run_orphaned",
      error: { code: "child_run_orphan_audit_required", message },
    },
    evidence: [],
    artifacts: [],
    workspaceChanges: [],
    unresolvedRisks: [message],
  };
}

export function isChildRunFact(value: unknown): value is ChildRunFact {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (
    typeof value.parentRunId !== "string" ||
    typeof value.childRunId !== "string" ||
    typeof value.delegationId !== "string" ||
    typeof value.inputFingerprint !== "string" ||
    typeof value.recordedAt !== "string"
  ) {
    return false;
  }
  if (value.budgetScope !== undefined && typeof value.budgetScope !== "string") return false;
  if (value.type === "delegation_recorded") {
    return (
      typeof value.parentTurnId === "string" &&
      typeof value.parentStepId === "string" &&
      typeof value.agentName === "string" &&
      isChildRunModelSnapshot(value.model) &&
      isChildRunWorkspaceSnapshot(value.workspace) &&
      isChildRunLifecyclePolicy(value.lifecyclePolicy) &&
      isChildRunContextReference(value.context) &&
      isChildRunPolicySnapshot(value.inheritedPolicy) &&
      isChildRunBudgetAllocation(value.requestedAllocation) &&
      isChildRunPermissionSnapshot(value.requestedPermissions) &&
      isChildRunEnvironmentRequirement(value.requestedEnvironment)
    );
  }
  if (value.type === "child_created" || value.type === "child_running") return true;
  if (value.type === "child_cancel_requested") {
    return (
      (value.requestedBy === "parent" ||
        value.requestedBy === "child" ||
        value.requestedBy === "join_timeout") &&
      typeof value.reason === "string"
    );
  }
  return (
    (value.type === "child_terminal" ||
      value.type === "child_paused" ||
      value.type === "child_orphaned" ||
      value.type === "parent_joined") &&
    isChildRunResult(value.result)
  );
}

function isChildRunContextReference(value: unknown): value is ChildRunContextReference {
  if (
    !isRecord(value) ||
    typeof value.workingSetFingerprint !== "string" ||
    !isStringArray(value.references)
  ) {
    return false;
  }
  if (value.resolvedReferences === undefined) return true;
  if (
    !Array.isArray(value.resolvedReferences) ||
    !value.resolvedReferences.every(isResolvedDelegatedContextReference)
  ) {
    return false;
  }
  const references = [...new Set(value.references)];
  return (
    references.length === value.resolvedReferences.length &&
    value.resolvedReferences.every((resolved, index) => resolved.reference === references[index])
  );
}

function isChildRunBudgetAllocation(value: unknown): value is ChildRunBudgetAllocation {
  if (!isRecord(value)) return false;
  return ["tokens", "toolCalls", "costUsd", "wallTimeMs", "steps", "descendants"].every((key) => {
    const item = value[key];
    return typeof item === "number" && Number.isFinite(item) && item >= 0;
  });
}

function isChildRunPermissionSnapshot(value: unknown): value is ChildRunPermissionSnapshot {
  return (
    isRecord(value) &&
    (value.mode === "ask" || value.mode === "assisted" || value.mode === "full") &&
    typeof value.workspaceOnly === "boolean" &&
    (value.network === "ask" || value.network === "allow" || value.network === "deny") &&
    isStringArray(value.tools) &&
    isStringArray(value.paths) &&
    isStringArray(value.credentials)
  );
}

function isChildRunPolicySnapshot(value: unknown): value is ChildRunPolicySnapshot {
  return (
    isRecord(value) &&
    typeof value.depth === "number" &&
    Number.isInteger(value.depth) &&
    value.depth >= 0 &&
    isChildRunBudgetAllocation(value.budget) &&
    isChildRunPermissionSnapshot(value.permissions) &&
    isChildRunEnvironmentRequirement(value.environment) &&
    isChildRunModelSnapshot(value.model) &&
    isChildRunWorkspaceSnapshot(value.workspace) &&
    isStringArray(value.protectedContextReferences) &&
    (value.protectedContextResolvedReferences === undefined ||
      (Array.isArray(value.protectedContextResolvedReferences) &&
        value.protectedContextResolvedReferences.every(isResolvedDelegatedContextReference))) &&
    (value.delegationModelRoutes === undefined ||
      (isRecord(value.delegationModelRoutes) &&
        Object.values(value.delegationModelRoutes).every(
          (routes) => isRecord(routes) && Object.values(routes).every(isChildRunModelSnapshot),
        ))) &&
    typeof value.maxDepth === "number" &&
    Number.isInteger(value.maxDepth) &&
    value.maxDepth >= 0 &&
    typeof value.maxActiveChildren === "number" &&
    Number.isInteger(value.maxActiveChildren) &&
    value.maxActiveChildren >= 0 &&
    (value.maxDescendants === undefined ||
      (typeof value.maxDescendants === "number" &&
        Number.isSafeInteger(value.maxDescendants) &&
        value.maxDescendants >= 0))
  );
}

function matchesConfiguredDelegationModel(
  configured: ChildRunModelSnapshot,
  requested: ChildRunModelSnapshot,
  tokenAllocation: number,
): boolean {
  if (!isChildRunModelSnapshot(configured) || !isChildRunModelSnapshot(requested)) return false;
  if (configured.providerId !== requested.providerId || configured.model !== requested.model) {
    return false;
  }
  if (
    configured.providerConfigFingerprint !== requested.providerConfigFingerprint ||
    configured.agentPromptFingerprint !== requested.agentPromptFingerprint ||
    configured.agentDelegationFingerprint !== requested.agentDelegationFingerprint
  ) {
    return false;
  }
  if (
    configured.options?.temperature !== requested.options?.temperature ||
    configured.options?.thinkingLevel !== requested.options?.thinkingLevel
  ) {
    return false;
  }
  const configuredMaxTokens = configured.options?.maxTokens;
  if (configuredMaxTokens === undefined) {
    return (
      requested.options?.maxTokens === undefined || requested.options.maxTokens <= tokenAllocation
    );
  }
  return requested.options?.maxTokens === Math.min(configuredMaxTokens, tokenAllocation);
}

function isChildRunModelSnapshot(value: unknown): value is ChildRunModelSnapshot {
  if (!isRecord(value) || typeof value.providerId !== "string" || typeof value.model !== "string") {
    return false;
  }
  if (
    typeof value.providerConfigFingerprint !== "string" ||
    typeof value.agentPromptFingerprint !== "string" ||
    typeof value.agentDelegationFingerprint !== "string"
  ) {
    return false;
  }
  if (value.options === undefined) return true;
  if (!isRecord(value.options)) return false;
  const { temperature, maxTokens, thinkingLevel } = value.options;
  return (
    (temperature === undefined ||
      (typeof temperature === "number" && temperature >= 0 && temperature <= 2)) &&
    (maxTokens === undefined ||
      (typeof maxTokens === "number" && Number.isInteger(maxTokens) && maxTokens >= 1)) &&
    (thinkingLevel === undefined ||
      thinkingLevel === "off" ||
      thinkingLevel === "low" ||
      thinkingLevel === "medium" ||
      thinkingLevel === "high" ||
      thinkingLevel === "xhigh")
  );
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function isChildRunWorkspaceSnapshot(value: unknown): value is ChildRunWorkspaceSnapshot {
  return (
    isRecord(value) && typeof value.canonicalRoot === "string" && value.lease === "shared_canonical"
  );
}

function isChildRunLifecyclePolicy(value: unknown): value is ChildRunLifecyclePolicy {
  return (
    isRecord(value) &&
    value.join === "structured" &&
    value.cancel === "propagate_parent" &&
    value.orphan === "audit_pause" &&
    (value.detach === "forbidden" || value.detach === "durable_preaccepted")
  );
}

function isChildRunResult(value: unknown): value is ChildRunResult {
  return (
    isRecord(value) &&
    isRecord(value.outcome) &&
    isRunOutcome(value.outcome) &&
    isStringArray(value.evidence) &&
    isStringArray(value.artifacts) &&
    isStringArray(value.workspaceChanges) &&
    isStringArray(value.unresolvedRisks)
  );
}

function isRunOutcome(value: Record<string, unknown>): boolean {
  const statuses = new Set([
    "succeeded",
    "failed",
    "paused",
    "aborted",
    "timeout",
    "budget_exceeded",
  ]);
  return (
    typeof value.status === "string" &&
    statuses.has(value.status) &&
    typeof value.finishReason === "string" &&
    (value.error === undefined ||
      (isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"))
  );
}

function isChildRunEnvironmentRequirement(value: unknown): value is ChildRunEnvironmentRequirement {
  if (!isRecord(value)) return false;
  const allowedKeys = new Set([
    "isolation",
    "readAccess",
    "writeAccess",
    "outsideWorkspaceAccess",
    "networkEgress",
    "credentialIsolation",
    "processControl",
    "termination",
    "durability",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  return (
    (value.isolation === undefined || value.isolation === "sandbox") &&
    (value.readAccess === undefined ||
      value.readAccess === "workspace" ||
      value.readAccess === "none") &&
    (value.writeAccess === undefined ||
      value.writeAccess === "workspace" ||
      value.writeAccess === "none") &&
    (value.outsideWorkspaceAccess === undefined || value.outsideWorkspaceAccess === "blocked") &&
    (value.networkEgress === undefined ||
      value.networkEgress === "controlled" ||
      value.networkEgress === "denied") &&
    (value.credentialIsolation === undefined ||
      value.credentialIsolation === "environment" ||
      value.credentialIsolation === "environment_and_files") &&
    (value.processControl === undefined ||
      value.processControl === "process" ||
      value.processControl === "process_tree") &&
    (value.durability === undefined || value.durability === "critical") &&
    (value.termination === undefined || isChildRunTerminationRequirement(value.termination))
  );
}

function isChildRunTerminationRequirement(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "kill" || key === "timeout" || key === "pty") &&
    (value.kill === undefined || value.kill === "process" || value.kill === "process_tree") &&
    (value.timeout === undefined || typeof value.timeout === "boolean") &&
    (value.pty === undefined || typeof value.pty === "boolean")
  );
}

export function foldChildRunLifecycleStatus(
  current: DelegationState["status"],
  type: ChildRunLifecycleFact["type"],
): ChildRunPersistedLifecycleStatus {
  if (current === "terminalizing") {
    throw new CoreMindError("run_state_corrupt", "Child Run terminalizing 不是可持久恢复状态");
  }
  if (current === "joined") {
    throw new CoreMindError("run_state_corrupt", "Child Run joined 后出现新的生命周期 Fact");
  }
  if (current === "terminal" || current === "paused" || current === "orphaned") {
    if (type === "parent_joined") return "joined";
    throw new CoreMindError("run_state_corrupt", "Child Run 已有结果后出现非法生命周期倒退");
  }
  if (type === "child_cancel_requested") return current;
  if (type === "child_orphaned") return "orphaned";
  switch (type) {
    case "child_created":
      if (current !== "recorded") break;
      return "created";
    case "child_running":
      if (current !== "created") break;
      return "running";
    case "child_terminal":
      if (current !== "running") break;
      return "terminal";
    case "child_paused":
      if (current !== "running") break;
      return "paused";
    case "parent_joined":
      throw new CoreMindError("run_state_corrupt", "Child Run 尚无结果时不能 parent_joined");
  }
  throw new CoreMindError("run_state_corrupt", `Child Run ${current} 状态不能接受 ${type} Fact`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
