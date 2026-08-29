import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  DelegationBudgetConfig,
  DelegationHierarchyLimitsConfig,
  ToolEffectDeclaration,
} from "coremind-config";
import { resolveToolCapability } from "coremind-tools";
import { CHILD_RUN_LIMIT_DEFAULTS, type DelegationDispositionAction } from "./child-run.js";
import { CoreMindError } from "./errors.js";
import type { CallId } from "./ids.js";

export const DELEGATION_TOOL_NAME = "delegate";
export const DELEGATION_DISPOSITION_TOOL_NAME = "dispose_delegation";
export const DELEGATION_TOOL_EFFECT: ToolEffectDeclaration = {
  operations: ["read"],
  reversible: true,
};
export const DELEGATION_TOOL_CAPABILITY = resolveToolCapability({
  tool: DELEGATION_TOOL_NAME,
  source: "registered",
  declaration: {
    effect: "none",
    replay: "safe",
    concurrency: "parallel",
    checkpoint: "none",
    durability: "critical",
  },
});
export const DELEGATION_DISPOSITION_TOOL_EFFECT: ToolEffectDeclaration = {
  operations: ["read"],
  reversible: true,
};
export const DELEGATION_DISPOSITION_TOOL_CAPABILITY = resolveToolCapability({
  tool: DELEGATION_DISPOSITION_TOOL_NAME,
  source: "registered",
  declaration: {
    effect: "none",
    replay: "safe",
    concurrency: "run_serial",
    checkpoint: "none",
    durability: "critical",
  },
});

export interface DelegationToolArgs {
  target: string;
  task: string;
  references: string[];
  recoveryOf?: string;
  limits?: DelegationToolLimits;
}

export interface DelegationDispositionToolArgs {
  delegationId: string;
  action: DelegationDispositionAction;
  reason: string;
}

export type DelegationToolLimits = Partial<
  DelegationBudgetConfig & Pick<DelegationHierarchyLimitsConfig, "maxDepth" | "maxActiveChildren">
>;

export function createDelegationAgentTool(
  targets: readonly string[],
  execute: (args: unknown, callId: CallId) => Promise<unknown>,
): AgentTool {
  return {
    name: DELEGATION_TOOL_NAME,
    label: "Delegate",
    description: "将一个受限任务委派给配置 allowlist 中的同项目命名 Agent，并等待结构化结果。",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: `允许的命名 Agent：${targets.join("、")}` },
        task: { type: "string", minLength: 1 },
        references: {
          type: "array",
          items: { type: "string", pattern: "^(fact|artifact):" },
        },
        recoveryOf: {
          type: "string",
          minLength: 1,
          description: "仅安全重新委派时填写的前一次 DelegationId。",
        },
        limits: {
          type: "object",
          properties: {
            tokens: { type: "integer", minimum: 1 },
            toolCalls: { type: "integer", minimum: 0 },
            costUsd: { type: "number", minimum: 0 },
            wallTimeMs: { type: "integer", minimum: 1 },
            steps: { type: "integer", minimum: 1 },
            descendants: { type: "integer", minimum: 0 },
            maxDepth: {
              type: "integer",
              minimum: 0,
              maximum: CHILD_RUN_LIMIT_DEFAULTS.maxDepth,
            },
            maxActiveChildren: {
              type: "integer",
              minimum: 0,
              maximum: CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren,
            },
          },
          additionalProperties: true,
        },
      },
      required: ["target", "task"],
      additionalProperties: true,
    },
    execute: async (callId, args) =>
      execute(args, callId as CallId) as ReturnType<AgentTool["execute"]>,
  } as AgentTool;
}

export function createDelegationDispositionAgentTool(
  execute: (args: unknown, callId: CallId) => Promise<unknown>,
): AgentTool {
  return {
    name: DELEGATION_DISPOSITION_TOOL_NAME,
    label: "Dispose Delegation",
    description:
      "记录一个未自动接受的 Child Run 持久处置。安全门要求人工时本工具会失败关闭；重新委派仍需随后调用 delegate 并填写 recoveryOf。",
    parameters: {
      type: "object",
      properties: {
        delegationId: { type: "string", minLength: 1 },
        action: {
          type: "string",
          enum: ["accept_failure", "choose_alternative", "redelegate", "propagate_terminal"],
        },
        reason: { type: "string", minLength: 1 },
      },
      required: ["delegationId", "action", "reason"],
      additionalProperties: false,
    },
    execute: async (callId, args) =>
      execute(args, callId as CallId) as ReturnType<AgentTool["execute"]>,
  } as AgentTool;
}

export function parseDelegationToolArgs(value: unknown): DelegationToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreMindError("invalid_tool", "delegate 参数必须是对象");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["target", "task", "references", "recoveryOf", "limits"]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      `delegate 不接受权限覆盖字段：${extra.join("、")}`,
    );
  }
  if (typeof record.target !== "string" || record.target.trim().length === 0) {
    throw new CoreMindError("invalid_tool", "delegate.target 必须是非空命名 Agent");
  }
  if (typeof record.task !== "string" || record.task.trim().length === 0) {
    throw new CoreMindError("invalid_tool", "delegate.task 必须是非空任务");
  }
  const references = record.references ?? [];
  if (
    !Array.isArray(references) ||
    references.some(
      (reference) =>
        typeof reference !== "string" || !/^(?:fact|artifact):[^\s]+$/u.test(reference),
    )
  ) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "delegate.references 只接受显式 fact: 或 artifact: 引用",
    );
  }
  const limits = parseDelegationLimits(record.limits);
  if (
    record.recoveryOf !== undefined &&
    (typeof record.recoveryOf !== "string" || record.recoveryOf.trim().length === 0)
  ) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      "delegate.recoveryOf 必须是非空 DelegationId",
    );
  }
  return {
    target: record.target,
    task: record.task,
    references: [...references],
    ...(typeof record.recoveryOf === "string" ? { recoveryOf: record.recoveryOf } : {}),
    ...(limits ? { limits } : {}),
  };
}

export function parseDelegationDispositionToolArgs(value: unknown): DelegationDispositionToolArgs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreMindError("delegation_disposition_conflict", "dispose_delegation 参数必须是对象");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["delegationId", "action", "reason"]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new CoreMindError(
      "delegation_disposition_conflict",
      "dispose_delegation 不接受安全证明或权限覆盖字段",
    );
  }
  if (typeof record.delegationId !== "string" || record.delegationId.trim().length === 0) {
    throw new CoreMindError(
      "delegation_disposition_conflict",
      "dispose_delegation.delegationId 必须是非空字符串",
    );
  }
  if (
    record.action !== "accept_failure" &&
    record.action !== "choose_alternative" &&
    record.action !== "redelegate" &&
    record.action !== "propagate_terminal"
  ) {
    throw new CoreMindError(
      "delegation_disposition_conflict",
      "dispose_delegation.action 不是受支持的处置动作",
    );
  }
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) {
    throw new CoreMindError(
      "delegation_disposition_conflict",
      "dispose_delegation.reason 必须是非空字符串",
    );
  }
  return {
    delegationId: record.delegationId,
    action: record.action,
    reason: record.reason,
  };
}

export function resolveDelegationAllocation(
  configured: DelegationBudgetConfig,
  requested: DelegationToolLimits | undefined,
): DelegationBudgetConfig {
  const allocation = { ...configured };
  for (const key of Object.keys(configured) as (keyof DelegationBudgetConfig)[]) {
    const requestedValue = requested?.[key];
    if (requestedValue !== undefined) allocation[key] = requestedValue;
    if (allocation[key] > configured[key]) {
      throw new CoreMindError(
        "child_run_policy_escalation",
        `delegate.limits.${key} 不能超过 Config allowlist 上限`,
      );
    }
  }
  return allocation;
}

export function resolveDelegationHierarchyLimits(
  configured: DelegationHierarchyLimitsConfig | undefined,
  requested: DelegationToolLimits | undefined,
): Pick<DelegationHierarchyLimitsConfig, "maxDepth" | "maxActiveChildren"> {
  const limits = {
    maxDepth: configured?.maxDepth ?? CHILD_RUN_LIMIT_DEFAULTS.maxDepth,
    maxActiveChildren: configured?.maxActiveChildren ?? CHILD_RUN_LIMIT_DEFAULTS.maxActiveChildren,
  };
  for (const key of ["maxDepth", "maxActiveChildren"] as const) {
    const requestedValue = requested?.[key];
    if (requestedValue === undefined) continue;
    if (requestedValue > limits[key]) {
      throw new CoreMindError(
        "child_run_policy_escalation",
        `delegate.limits.${key} 不能超过 Config 层级上限`,
      );
    }
    limits[key] = requestedValue;
  }
  return limits;
}

function parseDelegationLimits(value: unknown): DelegationToolLimits | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreMindError("child_run_policy_escalation", "delegate.limits 必须是对象");
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "tokens",
    "toolCalls",
    "costUsd",
    "wallTimeMs",
    "steps",
    "descendants",
    "maxDepth",
    "maxActiveChildren",
  ] as const;
  const extra = Object.keys(record).filter((key) => !keys.includes(key as (typeof keys)[number]));
  if (extra.length > 0) {
    throw new CoreMindError(
      "child_run_policy_escalation",
      `delegate.limits 不接受字段：${extra.join("、")}`,
    );
  }
  const limits: DelegationToolLimits = {};
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) continue;
    const minimum = key === "tokens" || key === "wallTimeMs" || key === "steps" ? 1 : 0;
    const requiresInteger = key !== "costUsd";
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      item < minimum ||
      (requiresInteger && !Number.isInteger(item))
    ) {
      throw new CoreMindError(
        "child_run_policy_escalation",
        `delegate.limits.${key} 不是有效的收紧预算`,
      );
    }
    limits[key] = item;
  }
  return limits;
}
