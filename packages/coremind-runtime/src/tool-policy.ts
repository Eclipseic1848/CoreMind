import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  type PermissionsConfig,
  TOOL_EFFECT_OPERATIONS,
  type ToolEffectDeclaration,
  type ToolEffectOperation,
  toolEffectOperationsForCapability,
} from "coremind-config";
import {
  inferLegacyToolCapability,
  isResolvedToolCapability,
  type ResolvedToolCapability,
  resolveToolCapability,
} from "coremind-tools";
import { collectDeclaredStringFields } from "./tool-effect-selectors.js";

export type ToolRisk = "low" | "high";
export type ApprovalDecision = "allow" | "deny";

export interface ToolEffect {
  operations: ToolEffectOperation[];
  paths: string[];
  urls: string[];
  reversible: boolean;
  declared: boolean;
}

export interface ToolApprovalRequest {
  approvalId: string;
  runId: string;
  agent: string;
  tool: string;
  args: unknown;
  risk: ToolRisk;
  reason: string;
  effect: ToolEffect;
  capability?: ResolvedToolCapability;
}

export interface ToolPolicyDecision {
  allowed: boolean;
  reason: string;
  approvalId?: string;
  approvedBy?: "configuration" | "mode" | "user";
}

export interface ToolPolicyOptions {
  permissions?: PermissionsConfig;
  cwd: string;
  runId: string;
  approve?: (request: ToolApprovalRequest) => Promise<ApprovalDecision>;
  createApprovalId: () => string;
  platform?: NodeJS.Platform;
  onApprovalRequired?: (request: ToolApprovalRequest) => void;
  onApprovalResolved?: (request: ToolApprovalRequest, decision: ApprovalDecision) => void;
}

const PATH_KEYS = new Set(["path", "file", "filepath", "cwd", "directory"]);

/** 三档权限的唯一判定点；显式 deny 和工作区边界始终优先。 */
export class ToolPolicy {
  private readonly permissions: Required<
    Pick<PermissionsConfig, "mode" | "workspaceOnly" | "network" | "allow" | "deny">
  >;

  constructor(private readonly options: ToolPolicyOptions) {
    this.permissions = {
      mode: options.permissions?.mode ?? "ask",
      workspaceOnly: options.permissions?.workspaceOnly ?? true,
      network: options.permissions?.network ?? "ask",
      allow: options.permissions?.allow ?? [],
      deny: options.permissions?.deny ?? [],
    };
  }

  async authorize(
    agent: string,
    tool: string,
    args: unknown,
    capabilityOrDeclaration?: ResolvedToolCapability | ToolEffectDeclaration,
    selectors?: ToolEffectDeclaration,
  ): Promise<ToolPolicyDecision> {
    if (matchesAny(tool, this.permissions.deny)) {
      return { allowed: false, reason: `工具 ${tool} 在 permissions.deny 中` };
    }

    const capability = resolvePolicyCapability(tool, capabilityOrDeclaration);
    if (capability.resolution === "fallback") {
      return {
        allowed: false,
        reason: `自定义工具 ${tool} 未声明副作用或完整 Capability，无法安全解析：${capability.issues.join("、")}`,
      };
    }
    if (capability.effect === "unknown" && capability.checkpoint === "unsupported") {
      return {
        allowed: false,
        reason: `工具 ${tool} 的 Effect 未知且无法建立必要 Checkpoint，已在执行前阻断`,
      };
    }
    const effect = resolveToolEffect(
      args,
      capability,
      selectors ?? legacySelectors(capabilityOrDeclaration),
    );

    if (
      tool === "bash" &&
      (this.options.platform ?? process.platform) === "win32" &&
      (this.permissions.workspaceOnly || this.permissions.network !== "allow")
    ) {
      return {
        allowed: false,
        reason:
          "Windows 主机 Shell 无法证明工作区或网络约束，已拒绝；请改用文件工具，或在 WSL2 中运行 CoreMind",
      };
    }

    if (
      capability.effect === "unknown" &&
      (this.permissions.workspaceOnly || this.permissions.network !== "allow")
    ) {
      return {
        allowed: false,
        reason: `自定义工具 ${tool} 未声明副作用，无法证明其满足工作区或网络约束`,
      };
    }

    const customTool = capability.source !== "builtin";
    if (
      customTool &&
      this.permissions.workspaceOnly &&
      effect.operations.includes("write") &&
      effect.paths.length === 0
    ) {
      return {
        allowed: false,
        reason: `自定义写工具 ${tool} 未暴露可检查的目标路径，无法证明其仅修改工作区`,
      };
    }
    if (
      customTool &&
      (effect.operations.includes("process") || effect.operations.includes("external")) &&
      (this.permissions.workspaceOnly || this.permissions.network !== "allow")
    ) {
      return {
        allowed: false,
        reason: `自定义工具 ${tool} 的 process/external 副作用无法证明满足工作区或网络约束`,
      };
    }

    if (this.permissions.workspaceOnly) {
      const escaped = await this.findEscapedPath(effect.paths);
      if (escaped) {
        return { allowed: false, reason: `路径超出工作区，已拒绝：${escaped}` };
      }
    }

    const networkTool =
      capability.effect === "network" || capability.effect === "external" || effect.urls.length > 0;
    if (networkTool && this.permissions.network === "deny") {
      return { allowed: false, reason: `网络策略拒绝工具 ${tool}` };
    }

    if (
      matchesAny(tool, this.permissions.allow) ||
      (networkTool && this.permissions.network === "allow")
    ) {
      return { allowed: true, reason: "配置已预先允许", approvedBy: "configuration" };
    }
    if (this.permissions.mode === "full" && !(networkTool && this.permissions.network === "ask")) {
      return { allowed: true, reason: "完全访问模式", approvedBy: "mode" };
    }
    if (this.permissions.mode === "assisted" && isLowRisk(capability) && !networkTool) {
      return { allowed: true, reason: "帮我批准模式的工作区内低风险工具", approvedBy: "mode" };
    }

    const risk: ToolRisk = isLowRisk(capability) && !networkTool ? "low" : "high";
    const request: ToolApprovalRequest = {
      approvalId: this.options.createApprovalId(),
      runId: this.options.runId,
      agent,
      tool,
      args,
      risk,
      reason: risk === "high" ? "敏感工具需要批准" : "请求批准模式要求逐项确认",
      effect,
      capability,
    };
    this.options.onApprovalRequired?.(request);
    if (!this.options.approve) {
      this.options.onApprovalResolved?.(request, "deny");
      return {
        allowed: false,
        reason: `工具 ${tool} 需要用户批准，但当前调用方未提供审批处理器`,
        approvalId: request.approvalId,
      };
    }
    const decision = await this.options.approve(request);
    this.options.onApprovalResolved?.(request, decision);
    return {
      allowed: decision === "allow",
      reason: decision === "allow" ? "用户已批准" : "用户已拒绝",
      approvalId: request.approvalId,
      ...(decision === "allow" ? { approvedBy: "user" as const } : {}),
    };
  }

  private async findEscapedPath(candidates: string[]): Promise<string | undefined> {
    if (candidates.length === 0) return undefined;
    const lexicalCwd = path.resolve(this.options.cwd);
    const canonicalCwd = await canonicalize(lexicalCwd);
    for (const candidate of candidates) {
      const addressed = path.resolve(lexicalCwd, candidate);
      if (isOutside(lexicalCwd, addressed)) return candidate;
      const canonicalTarget = await canonicalize(addressed);
      if (isOutside(canonicalCwd, canonicalTarget)) return candidate;
    }
    return undefined;
  }
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function matchesAny(tool: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
    return tool === pattern;
  });
}

function collectPathArguments(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectPathArguments);
  const paths: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.has(key.toLowerCase()) && typeof item === "string" && item.length > 0) {
      paths.push(item);
    }
    paths.push(...collectPathArguments(item));
  }
  return paths;
}

function resolveToolEffect(
  args: unknown,
  capability: ResolvedToolCapability,
  selectors?: ToolEffectDeclaration,
): ToolEffect {
  const paths = [
    ...collectPathArguments(args),
    ...collectDeclaredStringFields(args, selectors?.pathFields ?? []),
  ];
  const urls = [
    ...collectUrls(args),
    ...collectDeclaredStringFields(args, selectors?.urlFields ?? []).filter(isHttpUrl),
  ];
  const operations = toolEffectOperationsForCapability(capability.effect);
  if (urls.length > 0 && !operations.includes("network")) operations.push("network");
  return {
    operations,
    paths: unique(paths),
    urls: unique(urls),
    reversible:
      selectors?.reversible ?? (capability.replay === "safe" || capability.replay === "idempotent"),
    declared: capability.resolution === "resolved",
  };
}

function collectUrls(value: unknown): string[] {
  if (typeof value === "string") return isHttpUrl(value) ? [value] : [];
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(collectUrls);
  return Object.values(value as Record<string, unknown>).flatMap(collectUrls);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLowRisk(capability: ResolvedToolCapability): boolean {
  return capability.effect === "none" || capability.effect === "workspace";
}

function resolvePolicyCapability(
  tool: string,
  input: ResolvedToolCapability | ToolEffectDeclaration | undefined,
): ResolvedToolCapability {
  if (isResolvedToolCapability(input, tool)) return input;
  if (isLegacyEffectDeclaration(input)) return inferLegacyToolCapability(tool, input);
  if (input) return resolveToolCapability({ tool: `${tool}:invalid_capability` });
  return resolveToolCapability({ tool });
}

function isLegacyEffectDeclaration(value: unknown): value is ToolEffectDeclaration {
  return (
    value !== null &&
    typeof value === "object" &&
    "operations" in value &&
    Array.isArray(value.operations) &&
    value.operations.length > 0 &&
    value.operations.every((operation) => TOOL_EFFECT_OPERATIONS.includes(operation as never)) &&
    "reversible" in value &&
    typeof value.reversible === "boolean" &&
    (!("pathFields" in value) ||
      value.pathFields === undefined ||
      isStringArray(value.pathFields)) &&
    (!("urlFields" in value) || value.urlFields === undefined || isStringArray(value.urlFields))
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function legacySelectors(
  value: ResolvedToolCapability | ToolEffectDeclaration | undefined,
): ToolEffectDeclaration | undefined {
  return isLegacyEffectDeclaration(value) ? value : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function canonicalize(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      const existing = await realpath(current);
      return path.join(existing, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
