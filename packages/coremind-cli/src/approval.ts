import type { ApprovalDecision, CoreMindConfig, ToolApprovalRequest } from "coremind-ai";
import { redactSensitiveValue } from "coremind-ai/internal";
import { summarizeTerminalArguments, terminalText } from "./render.js";

export type PermissionMode = "ask" | "assisted" | "full";

export interface PendingApproval {
  request: ToolApprovalRequest;
}

export interface ApprovalQuestioner {
  question(prompt: string): Promise<string>;
}

export interface ApprovalDisplay {
  effect: string;
  targets: string;
  reason: string;
  arguments: string;
}

export interface DelegationApprovalDisplay {
  target: string;
  task: string;
  budget: string;
  hierarchy: string;
  references: string;
}

interface QueueEntry extends PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
}

/** 串行化并发工具审批，供 readline 与 TUI 共用。 */
export class ApprovalQueue {
  private readonly entries: QueueEntry[] = [];
  private readonly listeners = new Set<(pending: PendingApproval | undefined) => void>();

  constructor(private readonly interactive: boolean) {}

  get current(): PendingApproval | undefined {
    const entry = this.entries[0];
    return entry ? { request: entry.request } : undefined;
  }

  request(request: ToolApprovalRequest): Promise<ApprovalDecision> {
    if (!this.interactive) return Promise.resolve("deny");
    return new Promise((resolve) => {
      this.entries.push({ request, resolve });
      if (this.entries.length === 1) this.notify();
    });
  }

  resolve(decision: ApprovalDecision): void {
    const entry = this.entries.shift();
    if (!entry) return;
    entry.resolve(decision);
    this.notify();
  }

  subscribe(listener: (pending: PendingApproval | undefined) => void): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    while (this.entries.length > 0) this.resolve("deny");
    this.listeners.clear();
  }

  private notify(): void {
    const current = this.current;
    for (const listener of this.listeners) listener(current);
  }
}

export function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
  return value === "ask" || value === "assisted" || value === "full" ? value : undefined;
}

/** CLI 临时覆盖只改变批准强度，不会放宽工作区、网络、deny 或审计保护。 */
export function applyPermissionMode(config: CoreMindConfig, mode: PermissionMode): CoreMindConfig {
  return {
    ...config,
    permissions: { ...config.permissions, mode },
  };
}

/** 审批信息的单一格式化入口：目标优先，长正文摘要，凭据字段隐藏。 */
export function formatApprovalDisplay(request: ToolApprovalRequest): ApprovalDisplay {
  const safe = redactSensitiveValue(request) as ToolApprovalRequest;
  const targets = [...safe.effect.paths, ...safe.effect.urls];
  return {
    effect: terminalText(
      `${safe.effect.operations.join("+")} · ${safe.effect.reversible ? "可回退" : "不可自动回退"}`,
    ),
    targets: targets.length > 0 ? terminalText(targets.join("、")) : "未提供具体路径或 URL",
    reason: terminalText(safe.reason),
    arguments: summarizeTerminalArguments(safe.args),
  };
}

/** 委派批准在所有交互入口都显示固定目标、任务摘要、六维预算和显式引用。 */
export function formatDelegationApproval(
  request: ToolApprovalRequest,
): DelegationApprovalDisplay | undefined {
  if (request.tool !== "delegate" || !isRecord(request.args)) return undefined;
  const args = redactSensitiveValue(request.args, { redactBodies: false }) as Record<
    string,
    unknown
  >;
  const target = typeof args.target === "string" ? args.target : "未知目标";
  const task = typeof args.task === "string" ? args.task : "未提供任务";
  const limits = isRecord(args.limits) ? args.limits : {};
  const budget = [
    numericBudgetValue(limits.tokens, (value) => `${value} tokens`),
    numericBudgetValue(limits.toolCalls, (value) => `工具 ${value}`),
    numericBudgetValue(limits.costUsd, (value) => `$${value}`),
    numericBudgetValue(limits.wallTimeMs, (value) => `${value}ms`),
    numericBudgetValue(limits.steps, (value) => `步骤 ${value}`),
    numericBudgetValue(limits.descendants, (value) => `后代 ${value}`),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const references = Array.isArray(args.references)
    ? args.references.filter((item): item is string => typeof item === "string").join("、")
    : "";
  const hierarchy = [
    numericBudgetValue(limits.maxDepth, (value) => `最大深度 ${value}`),
    numericBudgetValue(limits.maxActiveChildren, (value) => `活动子级 ${value}`),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  return {
    target: compactChildRunText(target),
    task: summarizeDelegationTask(task),
    budget: budget || "使用 Config 默认预算",
    hierarchy: hierarchy || "使用 Config 层级上限",
    references: references ? terminalText(references) : "无显式 Fact/Artifact 引用",
  };
}

/** 把审批队列接到已有 readline；同一时间只提出一个问题。 */
export function bindReadlineApprovals(
  queue: ApprovalQueue,
  questioner: ApprovalQuestioner,
): () => void {
  let asking = false;
  let closed = false;
  const askCurrent = async () => {
    if (asking || closed || !queue.current) return;
    asking = true;
    const pending = queue.current;
    try {
      const display = formatApprovalDisplay(pending.request);
      const delegation = formatDelegationApproval(pending.request);
      const answer = await questioner.question(
        delegation
          ? `\nChild Run 委派审批：${delegation.target}\n任务：${delegation.task}\n预算：${delegation.budget}\n层级：${delegation.hierarchy}\n引用：${delegation.references}\n授权：仅创建 Child Run；子级工具与外部副作用仍需独立审批\n原因：${display.reason}\n允许？[y/N] `
          : `\n工具 ${terminalText(pending.request.tool, 512)} 请求${pending.request.risk === "high" ? "高风险" : ""}权限\n副作用：${display.effect}\n目标：${display.targets}\n原因：${display.reason}\n参数：${display.arguments}\n允许？[y/N] `,
      );
      if (queue.current?.request === pending.request)
        queue.resolve(answer.trim().toLowerCase() === "y" ? "allow" : "deny");
    } catch {
      if (queue.current?.request === pending.request) queue.resolve("deny");
    } finally {
      asking = false;
      if (queue.current) void askCurrent();
    }
  };
  const unsubscribe = queue.subscribe(() => void askCurrent());
  return () => {
    closed = true;
    unsubscribe();
  };
}

export function compactChildRunText(value: string, maxLength = 160): string {
  return terminalText(value.replace(/\s+/g, " ").trim(), maxLength);
}

function summarizeDelegationTask(value: string): string {
  const compact = terminalText(value.replace(/\s+/g, " ").trim());
  return compact.length <= 160
    ? compact
    : `${terminalText(compact, 24)}…（任务 ${compact.length} 字符）`;
}

function numericBudgetValue(value: unknown, format: (value: number) => string): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
