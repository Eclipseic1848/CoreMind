import type { ApprovalDecision, CoreMindConfig, ToolApprovalRequest } from "coremind-ai";

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
  const targets = [...request.effect.paths, ...request.effect.urls];
  return {
    effect: `${request.effect.operations.join("+")} · ${request.effect.reversible ? "可回退" : "不可自动回退"}`,
    targets: targets.length > 0 ? targets.join("、") : "未提供具体路径或 URL",
    reason: request.reason,
    arguments: JSON.stringify(summarizeArguments(request.args), null, 2) ?? String(request.args),
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
      const answer = await questioner.question(
        `\n工具 ${pending.request.tool} 请求${pending.request.risk === "high" ? "高风险" : ""}权限\n副作用：${display.effect}\n目标：${display.targets}\n原因：${display.reason}\n参数：${display.arguments}\n允许？[y/N] `,
      );
      queue.resolve(answer.trim().toLowerCase() === "y" ? "allow" : "deny");
    } catch {
      queue.resolve("deny");
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

function summarizeArguments(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "<嵌套过深，已省略>";
  if (typeof value === "string") {
    if (/token|secret|password|api[_-]?key|authorization/i.test(key)) return "<已隐藏>";
    if (/content|body|text|patch/i.test(key) && value.length > 160) {
      return `<正文 ${value.length} 字符，审批后写入>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => summarizeArguments(item, key, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, item]) => [
        childKey,
        summarizeArguments(item, childKey, depth + 1),
      ]),
    );
  }
  return value;
}
