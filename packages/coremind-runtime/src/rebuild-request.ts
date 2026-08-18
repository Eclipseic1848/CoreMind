import type { AgentMessage, CompactionEntry, Entry } from "@earendil-works/pi-agent-core";
import { applyCompaction, projectRawBranchMessages } from "./compaction-projection.js";
import type { StableContextPrefix } from "./context.js";

/** 请求消息 = 内部 LLM 消息 + system 稳定前缀（与 wire 发送对齐） */
export type RequestMessage = AgentMessage | SystemRequestMessage;

export interface SystemRequestMessage {
  role: "system";
  content: string;
  timestamp: number;
}

/**
 * 请求重建输入（规格 01 §2 重建公式）：
 * - entries：会话树主 lane 全部条目（oldestFirst，该 Run 结束时已落盘）
 * - compactions：会话树中的压缩条目序列（可经 entries 过滤得到）
 * - stablePrefix：buildStableContextPrefix(config) 产物（确定性 system 前缀）
 */
export interface RebuildRunRequestInput {
  entries: readonly Entry[];
  compactions: readonly CompactionEntry[];
  stablePrefix: StableContextPrefix;
}

/**
 * 从持久事实重建 Run 的完整 Provider 请求消息列表（规格 01 §2.1）：
 * 请求 = buildStableContextPrefix(config) + applyCompaction(会话树 branch 消息, 压缩条目序列)
 *       + 本轮 Turn 消息（压缩产物末尾之后落盘的消息条目）
 * 输出第一项为 system 稳定前缀，其后为应用压缩后的重建消息。
 * applyCompaction 输出截断到最后压缩条目的产物末尾；其后的落盘消息属于本轮，另行拼接。
 * 会话树末尾的最终 assistant 回复是模型产出、不发送（历史回复属于上下文，保留）。
 */
export function rebuildRunRequest(input: RebuildRunRequestInput): RequestMessage[] {
  const raw = projectRawBranchMessages(input.entries);
  const rebuilt = applyCompaction(raw, input.compactions);
  let messages: RequestMessage[] = [...rebuilt];
  if (input.compactions.length > 0) {
    const lastCompactionSeq = input.compactions.reduce(
      (max, compaction) => Math.max(max, compaction.seq),
      0,
    );
    const turnMessages = raw
      .filter((item) => item.seq > lastCompactionSeq)
      .map((item) => item.message);
    messages = [...rebuilt, ...turnMessages];
  }
  return [
    { role: "system", content: input.stablePrefix.text, timestamp: 0 },
    ...dropUnsentTrailing(messages),
  ];
}

/**
 * 去掉末尾的所有 assistant 消息（模型产出不进入请求，最后一次请求不以 assistant 结尾）。
 * 历史中的 assistant 回复后面有 user/toolResult 消息，保留；孤立的 toolUse（审批拒绝等
 * 未发送的产出）与最终回复一并剔除。
 */
function dropUnsentTrailing(messages: RequestMessage[]): RequestMessage[] {
  let end = messages.length;
  while (end > 0 && messages[end - 1]?.role === "assistant") end -= 1;
  return messages.slice(0, end);
}
