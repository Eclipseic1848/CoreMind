import type { ApprovalDecision, CoreMindConfig, ToolApprovalRequest } from "coremind-ai";

export type PermissionMode = "ask" | "assisted" | "full";

export interface PendingApproval {
  request: ToolApprovalRequest;
}

export interface ApprovalQuestioner {
  question(prompt: string): Promise<string>;
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
      const args = JSON.stringify(pending.request.args);
      const answer = await questioner.question(
        `\n工具 ${pending.request.tool} 请求${pending.request.risk === "high" ? "高风险" : ""}权限\n参数：${args}\n允许？[y/N] `,
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
