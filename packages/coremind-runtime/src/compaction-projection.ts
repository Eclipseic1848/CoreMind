import {
  type AgentMessage,
  type CompactionEntry,
  createCompactionSummaryMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";

/** 视图消息 + 来源条目 id（压缩替换范围按条目 id 定位） */
export interface BranchMessage {
  message: AgentMessage;
  entryId: string;
  /** 来源条目的 seq（压缩条目应用的顺序边界） */
  seq: number;
}

/** CoreMind 确定性压缩条目在 details 中携带的扩展字段 */
export interface CoremindCompactionDetails {
  /** 摘要文本指纹（与 context_compacted 事件一致） */
  fingerprint: string;
  /** 替换范围起点（被替换的第一条视图消息的来源条目 id） */
  rangeStartId: string;
  /** 替换范围终点（被替换的最后一条视图消息的来源条目 id） */
  rangeEndId: string;
  /** 发送摘要消息的时间戳（重建字节级一致用；缺省回退条目 timestamp） */
  summaryTimestamp?: number;
}

/** 判断压缩条目是否为 CoreMind 确定性压缩（details 携带替换范围） */
export function isCoremindCompaction(
  entry: Entry | CompactionEntry,
): entry is CompactionEntry & { details: CoremindCompactionDetails } {
  if (entry.type !== "compaction") return false;
  const details = entry.details as Partial<CoremindCompactionDetails> | undefined;
  return (
    typeof details?.fingerprint === "string" &&
    typeof details.rangeStartId === "string" &&
    typeof details.rangeEndId === "string"
  );
}

/**
 * 镜像上游 buildSessionContext 的消息语义，并标注每条消息的来源条目 id。
 * 最后一条压缩条目之前的消息被摘要与保留尾部替换（与恢复视图一致）。
 * 运行时用它与 transformContext 的输入消息对齐，桥接压缩替换范围。
 */
export function projectBranchMessages(entries: readonly Entry[]): BranchMessage[] {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  const visible = compactionIndex < 0 ? entries : entries.slice(compactionIndex);
  const result: BranchMessage[] = [];
  for (const entry of visible) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant" && entry.message.stopReason === "deferred") continue;
      result.push({ message: entry.message, entryId: entry.id, seq: entry.seq });
    } else if (entry.type === "compaction") {
      result.push({
        message: createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
        entryId: entry.id,
        seq: entry.seq,
      });
      for (const retained of entry.retainedTail) {
        result.push({ message: retained, entryId: entry.id, seq: entry.seq });
      }
    }
  }
  return result;
}

/** 原始 branch 消息（不预应用任何压缩）：全部消息条目按序，压缩条目留待 applyCompaction 应用 */
export function projectRawBranchMessages(entries: readonly Entry[]): BranchMessage[] {
  const result: BranchMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "assistant" && entry.message.stopReason === "deferred") continue;
    result.push({ message: entry.message, entryId: entry.id, seq: entry.seq });
  }
  return result;
}

/**
 * 按压缩条目序列（seq 升序）重建实际发送的历史消息。
 * - CoreMind 确定性压缩（有替换范围）：范围起点之前的消息保留，其余 seq 更早的消息
 *   由 [摘要（user 格式）, ...保留尾部] 覆盖（与 protectContext 发送格式一致）；
 * - 上游 LLM 压缩（无范围）：其之前全部消息由 [摘要（compactionSummary 格式）, ...保留尾部] 替换。
 * 输出截断到最后一条压缩条目的产物末尾：其后落盘的消息属于"本轮 Turn 消息"，由调用方另行拼接。
 */
export function applyCompaction(
  branchMessages: readonly BranchMessage[],
  compactions: readonly CompactionEntry[],
): AgentMessage[] {
  let current = branchMessages.map((item) => ({ ...item }));
  const ordered = [...compactions].sort((left, right) => left.seq - right.seq);
  let lastAppliedSeq: number | undefined;
  for (const compaction of ordered) {
    const before = current.filter((item) => item.seq < compaction.seq);
    const after = current.filter((item) => item.seq >= compaction.seq);
    if (isCoremindCompaction(compaction)) {
      const startIndex = before.findIndex(
        (item) => item.entryId === compaction.details.rangeStartId,
      );
      if (startIndex < 0) continue;
      const replaced: BranchMessage[] = [
        {
          message: {
            role: "user",
            content: compaction.summary,
            // 与 protectContext 发送摘要的时间戳一致（字节级重建）
            timestamp: compaction.details.summaryTimestamp ?? compaction.timestamp,
          } as AgentMessage,
          entryId: compaction.id,
          seq: compaction.seq,
        },
        ...compaction.retainedTail.map((message) => ({
          message,
          entryId: compaction.id,
          seq: compaction.seq,
        })),
      ];
      current = [...before.slice(0, startIndex), ...replaced, ...after];
    } else {
      const replaced: BranchMessage[] = [
        {
          message: createCompactionSummaryMessage(
            compaction.summary,
            compaction.tokensBefore,
            compaction.timestamp,
          ),
          entryId: compaction.id,
          seq: compaction.seq,
        },
        ...compaction.retainedTail.map((message) => ({
          message,
          entryId: compaction.id,
          seq: compaction.seq,
        })),
      ];
      current = [...replaced, ...after];
    }
    lastAppliedSeq = compaction.seq;
  }
  if (lastAppliedSeq === undefined) return current.map((item) => item.message);
  return current.filter((item) => item.seq <= lastAppliedSeq).map((item) => item.message);
}
