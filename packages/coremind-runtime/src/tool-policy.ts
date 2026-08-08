import { realpath } from "node:fs/promises";
import path from "node:path";
import type { PermissionsConfig } from "coremind-config";

export type ToolRisk = "low" | "high";
export type ApprovalDecision = "allow" | "deny";

export interface ToolApprovalRequest {
  approvalId: string;
  runId: string;
  agent: string;
  tool: string;
  args: unknown;
  risk: ToolRisk;
  reason: string;
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
  onApprovalRequired?: (request: ToolApprovalRequest) => void;
  onApprovalResolved?: (request: ToolApprovalRequest, decision: ApprovalDecision) => void;
}

const LOW_RISK_TOOLS = new Set(["read", "ls", "find", "grep", "edit", "write"]);
const NETWORK_TOOLS = new Set(["web-fetch", "web-search"]);
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

  async authorize(agent: string, tool: string, args: unknown): Promise<ToolPolicyDecision> {
    if (matchesAny(tool, this.permissions.deny)) {
      return { allowed: false, reason: `工具 ${tool} 在 permissions.deny 中` };
    }

    if (this.permissions.workspaceOnly) {
      const escaped = await this.findEscapedPath(args);
      if (escaped) {
        return { allowed: false, reason: `路径超出工作区，已拒绝：${escaped}` };
      }
    }

    const networkTool = NETWORK_TOOLS.has(tool);
    if (networkTool && this.permissions.network === "deny") {
      return { allowed: false, reason: `网络策略拒绝工具 ${tool}` };
    }

    if (
      matchesAny(tool, this.permissions.allow) ||
      (networkTool && this.permissions.network === "allow")
    ) {
      return { allowed: true, reason: "配置已预先允许", approvedBy: "configuration" };
    }
    if (this.permissions.mode === "full") {
      return { allowed: true, reason: "完全访问模式", approvedBy: "mode" };
    }
    if (this.permissions.mode === "assisted" && LOW_RISK_TOOLS.has(tool) && !networkTool) {
      return { allowed: true, reason: "帮我批准模式的工作区内低风险工具", approvedBy: "mode" };
    }

    const risk: ToolRisk = LOW_RISK_TOOLS.has(tool) && !networkTool ? "low" : "high";
    const request: ToolApprovalRequest = {
      approvalId: this.options.createApprovalId(),
      runId: this.options.runId,
      agent,
      tool,
      args,
      risk,
      reason: risk === "high" ? "敏感工具需要批准" : "请求批准模式要求逐项确认",
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

  private async findEscapedPath(args: unknown): Promise<string | undefined> {
    const candidates = collectPathArguments(args);
    if (candidates.length === 0) return undefined;
    const canonicalCwd = await canonicalize(this.options.cwd);
    for (const candidate of candidates) {
      const addressed = path.resolve(this.options.cwd, candidate);
      const canonicalTarget = await canonicalize(addressed);
      const relative = path.relative(canonicalCwd, canonicalTarget);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        return candidate;
      }
    }
    return undefined;
  }
}

function matchesAny(tool: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
    return tool === pattern;
  });
}

function collectPathArguments(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (PATH_KEYS.has(key.toLowerCase()) && typeof item === "string" && item.length > 0) {
      paths.push(item);
    }
  }
  return paths;
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
