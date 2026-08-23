import {
  BUILTIN_TOOL_CAPABILITIES,
  type BuiltinToolId,
  TOOL_CAPABILITY_CHECKPOINTS,
  TOOL_CAPABILITY_CONCURRENCY,
  TOOL_CAPABILITY_DURABILITY,
  TOOL_CAPABILITY_EFFECTS,
  TOOL_CAPABILITY_REPLAYS,
  type ToolCapabilityCheckpoint,
  type ToolCapabilityConcurrency,
  type ToolCapabilityDeclaration,
  type ToolCapabilityDurability,
  type ToolCapabilityEffect,
  type ToolCapabilityReplay,
  type ToolEffectDeclaration,
} from "coremind-config";

export type {
  ToolCapabilityCheckpoint,
  ToolCapabilityConcurrency,
  ToolCapabilityDeclaration,
  ToolCapabilityDurability,
  ToolCapabilityEffect,
  ToolCapabilityReplay,
};
export {
  BUILTIN_TOOL_CAPABILITIES,
  TOOL_CAPABILITY_CHECKPOINTS,
  TOOL_CAPABILITY_CONCURRENCY,
  TOOL_CAPABILITY_DURABILITY,
  TOOL_CAPABILITY_EFFECTS,
  TOOL_CAPABILITY_REPLAYS,
};
export type ToolCapabilitySource = "builtin" | "registered" | "inferred" | "fallback";
export type ToolCapabilityResolution = "resolved" | "fallback";
export type CapabilityConstraintOrigin = "config" | "extension" | "host" | "entrypoint";
export const RECOVERY_DISPOSITIONS = [
  "replay_safe",
  "requires_proof",
  "requires_human",
  "forbidden",
] as const;
export type RecoveryDisposition = (typeof RECOVERY_DISPOSITIONS)[number];

export interface ToolCapabilityConstraint {
  origin: CapabilityConstraintOrigin;
  capability: Partial<ToolCapabilityDeclaration>;
}

export interface ResolveToolCapabilityInput {
  tool: string;
  source?: Exclude<ToolCapabilitySource, "fallback">;
  declaration?: Partial<ToolCapabilityDeclaration>;
  constraints?: readonly ToolCapabilityConstraint[];
}

export interface ResolvedToolCapability extends ToolCapabilityDeclaration {
  tool: string;
  source: ToolCapabilitySource;
  resolution: ToolCapabilityResolution;
  issues: readonly string[];
}

const FALLBACK_DECLARATION: ToolCapabilityDeclaration = freezeDeclaration({
  effect: "unknown",
  replay: "unknown",
  concurrency: "run_serial",
  checkpoint: "unsupported",
  durability: "critical",
});

const DIMENSIONS = ["effect", "replay", "concurrency", "checkpoint", "durability"] as const;
const RESOLVABLE_SOURCES = new Set<ToolCapabilitySource>(["builtin", "registered", "inferred"]);

const RESTRICTIVENESS: {
  [K in keyof ToolCapabilityDeclaration]: Readonly<Record<ToolCapabilityDeclaration[K], number>>;
} = {
  effect: { none: 0, workspace: 1, process: 2, network: 3, external: 4, unknown: 5 },
  replay: { safe: 0, idempotent: 1, unsafe: 2, unknown: 3 },
  concurrency: { parallel: 0, run_serial: 1, workspace_exclusive: 2 },
  checkpoint: { none: 0, required: 1, unsupported: 2 },
  durability: { ordinary: 0, critical: 1 },
};

/**
 * 解析一次工具调用的不可变能力。缺失、非法或降权冲突均返回最严格 fallback，
 * 让调用方可以记录 Fact 后失败关闭，而不是按工具名称猜测安全性。
 */
export function resolveToolCapability(input: ResolveToolCapabilityInput): ResolvedToolCapability {
  const builtin = BUILTIN_TOOL_CAPABILITIES[input.tool as BuiltinToolId];
  const declaration = input.declaration ?? builtin;
  const source = input.declaration ? (input.source ?? "inferred") : builtin ? "builtin" : undefined;
  const declarationIssues = validateDeclaration(declaration);
  if (!source) return fallback(input.tool, ["capability_unregistered", ...declarationIssues]);
  if (!RESOLVABLE_SOURCES.has(source)) return fallback(input.tool, ["capability_invalid:source"]);
  if (declarationIssues.length > 0) return fallback(input.tool, declarationIssues);
  if (
    source === "builtin" &&
    (!builtin || !sameDeclaration(declaration as ToolCapabilityDeclaration, builtin))
  ) {
    return fallback(input.tool, ["capability_invalid:builtin_source"]);
  }

  const resolved = { ...(declaration as ToolCapabilityDeclaration) };
  const constraintIssues: string[] = [];
  for (const constraint of input.constraints ?? []) {
    for (const dimension of DIMENSIONS) {
      const candidate = constraint.capability[dimension];
      if (candidate === undefined) continue;
      if (!isDimensionValue(dimension, candidate)) {
        constraintIssues.push(`capability_invalid:${constraint.origin}:${dimension}`);
        continue;
      }
      const relation = constraintRelation(dimension, resolved[dimension], candidate);
      if (relation === "downgrade") {
        constraintIssues.push(`capability_downgrade:${constraint.origin}:${dimension}`);
        continue;
      }
      if (relation === "conflict") {
        constraintIssues.push(`capability_conflict:${constraint.origin}:${dimension}`);
        continue;
      }
      assignDimension(resolved, dimension, candidate);
    }
  }
  if (constraintIssues.length > 0) return fallback(input.tool, constraintIssues);
  const resolvedIssues = validateDeclaration(resolved);
  if (resolvedIssues.length > 0) return fallback(input.tool, resolvedIssues);

  return freezeResolved({
    tool: input.tool,
    ...resolved,
    source,
    resolution: "resolved",
    issues: [],
  });
}

export function recoveryDispositionFor(
  capability: Pick<ResolvedToolCapability, "effect" | "replay">,
): RecoveryDisposition {
  switch (capability.replay) {
    case "safe":
      return capability.effect === "none" ? "replay_safe" : "requires_proof";
    case "idempotent":
      return "requires_proof";
    case "unsafe":
      return "forbidden";
    case "unknown":
      return "requires_human";
  }
}

/** 在 JavaScript、RunState 与插件等非类型安全边界验证完整且自洽的解析结果。 */
export function isResolvedToolCapability(
  value: unknown,
  expectedTool?: string,
): value is ResolvedToolCapability {
  if (value === null || typeof value !== "object") return false;
  const capability = value as Record<string, unknown>;
  const validSource =
    RESOLVABLE_SOURCES.has(capability.source as ToolCapabilitySource) ||
    capability.source === "fallback";
  if (
    typeof capability.tool !== "string" ||
    (expectedTool !== undefined && capability.tool !== expectedTool) ||
    validateDeclaration(capability as Partial<ToolCapabilityDeclaration>).length > 0 ||
    !validSource ||
    !["resolved", "fallback"].includes(String(capability.resolution)) ||
    !Array.isArray(capability.issues) ||
    !capability.issues.every((issue) => typeof issue === "string")
  ) {
    return false;
  }
  if (capability.resolution === "fallback") {
    return (
      capability.source === "fallback" &&
      capability.issues.length > 0 &&
      capability.effect === FALLBACK_DECLARATION.effect &&
      capability.replay === FALLBACK_DECLARATION.replay &&
      capability.concurrency === FALLBACK_DECLARATION.concurrency &&
      capability.checkpoint === FALLBACK_DECLARATION.checkpoint &&
      capability.durability === FALLBACK_DECLARATION.durability
    );
  }
  if (capability.source === "builtin") {
    const builtin = BUILTIN_TOOL_CAPABILITIES[capability.tool as BuiltinToolId];
    if (!builtin || !sameDeclaration(capability as unknown as ToolCapabilityDeclaration, builtin)) {
      return false;
    }
  }
  return capability.source !== "fallback" && capability.issues.length === 0;
}

/** 供 0.3.x 旧 effect 调用方与 Runtime 注册兼容；新集成应直接声明完整 Capability。 */
export function inferLegacyToolCapability(
  tool: string,
  declaration: ToolEffectDeclaration,
): ResolvedToolCapability {
  const operations = new Set(declaration.operations);
  const mutableBoundaries = ["write", "process", "network", "external"].filter((operation) =>
    operations.has(operation as ToolEffectDeclaration["operations"][number]),
  );
  if (mutableBoundaries.length > 1) {
    return resolveToolCapability({ tool, source: "inferred", declaration: {} });
  }
  const effect: ToolCapabilityEffect = operations.has("external")
    ? "external"
    : operations.has("network")
      ? "network"
      : operations.has("process")
        ? "process"
        : operations.has("write")
          ? "workspace"
          : operations.size === 1 && operations.has("read")
            ? "none"
            : "unknown";
  return resolveToolCapability({
    tool,
    source: "inferred",
    declaration: {
      effect,
      replay: effect === "none" ? "safe" : "unknown",
      concurrency:
        effect === "none"
          ? "parallel"
          : effect === "workspace"
            ? "workspace_exclusive"
            : "run_serial",
      checkpoint:
        effect === "none" || effect === "network"
          ? "none"
          : effect === "workspace"
            ? "required"
            : "unsupported",
      durability: effect === "none" ? "ordinary" : "critical",
    },
  });
}

function validateDeclaration(
  declaration: Partial<ToolCapabilityDeclaration> | undefined,
): string[] {
  if (!declaration) return ["capability_missing"];
  const issues: string[] = [];
  for (const dimension of DIMENSIONS) {
    const value = declaration[dimension];
    if (value === undefined) issues.push(`capability_missing:${dimension}`);
    else if (!isDimensionValue(dimension, value)) issues.push(`capability_invalid:${dimension}`);
  }
  if (
    issues.length === 0 &&
    (declaration.effect === "workspace" || declaration.effect === "unknown") &&
    declaration.checkpoint === "none"
  ) {
    issues.push(`capability_conflict:${declaration.effect}:checkpoint`);
  }
  return issues;
}

function isDimensionValue<K extends keyof ToolCapabilityDeclaration>(
  dimension: K,
  value: unknown,
): value is ToolCapabilityDeclaration[K] {
  return Object.hasOwn(RESTRICTIVENESS[dimension], value as PropertyKey);
}

function rank<K extends keyof ToolCapabilityDeclaration>(
  dimension: K,
  value: ToolCapabilityDeclaration[K],
): number {
  return RESTRICTIVENESS[dimension][value];
}

function constraintRelation<K extends keyof ToolCapabilityDeclaration>(
  dimension: K,
  current: ToolCapabilityDeclaration[K],
  candidate: ToolCapabilityDeclaration[K],
): "same" | "tighten" | "downgrade" | "conflict" {
  if (candidate === current) return "same";
  if (dimension !== "effect") {
    return rank(dimension, candidate) > rank(dimension, current) ? "tighten" : "downgrade";
  }
  const currentEffect = current as ToolCapabilityEffect;
  const candidateEffect = candidate as ToolCapabilityEffect;
  if (candidateEffect === "unknown" || currentEffect === "none") return "tighten";
  if (candidateEffect === "none" || currentEffect === "unknown") return "downgrade";
  return "conflict";
}

function assignDimension<K extends keyof ToolCapabilityDeclaration>(
  target: ToolCapabilityDeclaration,
  dimension: K,
  value: ToolCapabilityDeclaration[K],
): void {
  target[dimension] = value;
}

function sameDeclaration(
  left: ToolCapabilityDeclaration,
  right: ToolCapabilityDeclaration,
): boolean {
  return DIMENSIONS.every((dimension) => left[dimension] === right[dimension]);
}

function fallback(tool: string, issues: string[]): ResolvedToolCapability {
  return freezeResolved({
    tool,
    ...FALLBACK_DECLARATION,
    source: "fallback",
    resolution: "fallback",
    issues,
  });
}

function freezeDeclaration(declaration: ToolCapabilityDeclaration): ToolCapabilityDeclaration {
  return Object.freeze(declaration);
}

function freezeResolved(capability: ResolvedToolCapability): ResolvedToolCapability {
  const issues = Object.freeze([...capability.issues]);
  return Object.freeze({ ...capability, issues });
}
