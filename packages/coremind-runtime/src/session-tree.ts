import { CoreMindError } from "./errors.js";
import type { CoreMindMessage } from "./public-message.js";

/** 节点必须显式绑定所属会话；分叉复制的历史 id 不能替代会话身份。 */
export interface ChatSessionNodeRef {
  sessionId: string;
  entryId: string;
}

/** 只读树节点；内部维护数据与存储写入能力不从此 DTO 暴露。 */
export interface ChatSessionTreeNode {
  id: string;
  parentId: string | null;
  seq: number;
  type:
    | "message"
    | "model_change"
    | "thinking_level_change"
    | "active_tools_change"
    | "compaction"
    | "branch_summary"
    | "custom";
  message?: CoreMindMessage;
  summary?: string;
}

export interface ChatSessionBranch {
  id: string;
  leafId: string | null;
}

/** 会话消息仍是未脱敏历史，宿主必须控制此查询的访问权限。 */
export interface ChatSessionTree {
  sessionId: string;
  activeBranch: string;
  branches: ChatSessionBranch[];
  nodes: ChatSessionTreeNode[];
  forkedFrom?: ChatSessionNodeRef;
}

/** Runtime 与 ChatSession 的内部导航请求，不从包入口导出。 */
export type SessionNavigation =
  | { type: "inspect" }
  | { type: "create"; branchId: string; at: ChatSessionNodeRef | null }
  | { type: "select"; branchId: string }
  | { type: "fork"; at: ChatSessionNodeRef };

type SessionNavigator = (
  agentName: string,
  history: CoreMindMessage[],
  operation: SessionNavigation,
) => Promise<{ tree: ChatSessionTree; history?: CoreMindMessage[] }>;
const navigators = new WeakMap<object, SessionNavigator>();

/** 内部绑定避免 ChatSession 反向导入整个 Runtime 的实现。 */
export function bindSessionNavigation(owner: object, navigate: SessionNavigator): void {
  navigators.set(owner, navigate);
}

/** 只允许已注册 Runtime 的最小导航能力，不从包入口导出。 */
export function navigateChatSession(
  owner: object,
  agentName: string,
  history: CoreMindMessage[],
  operation: SessionNavigation,
): ReturnType<SessionNavigator> {
  const navigate = navigators.get(owner);
  if (!navigate)
    return Promise.reject(
      new CoreMindError("session_navigation_invalid", "此 Runtime 未注册会话导航"),
    );
  return navigate(agentName, history, operation);
}
