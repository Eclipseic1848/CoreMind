/*!
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
// 保留既有会话合同，避免依赖升级改变历史存储与恢复语义。
import type { StopReason, Usage } from "@earendil-works/pi-ai";
import "../messages.js";
import type { AgentMessage } from "../message-types.js";
import type { Session } from "./session.js";
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | {
      [key: string]: JsonValue;
    };
export type SessionStopReason = Exclude<StopReason, "pending"> | "deferred";
export interface IdGenerator {
  next(): string;
}
export interface EntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
}
export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
  terminate?: true;
}
export interface ModelChangeEntry extends EntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}
export interface ThinkingLevelEntry extends EntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}
export interface ActiveToolsEntry extends EntryBase {
  type: "active_tools_change";
  activeToolNames: string[];
}
export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: unknown;
  usage?: Usage;
}
export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  usage?: Usage;
}
export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}
export type Entry =
  | MessageEntry
  | ModelChangeEntry
  | ThinkingLevelEntry
  | ActiveToolsEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry;
export type ProvisionedEntry<TEntry extends Entry = Entry> = TEntry extends Entry
  ? Omit<TEntry, "parentId" | "seq" | "timestamp">
  : never;
export interface RecordBase {
  id: string;
  seq: number;
  lane: string;
  timestamp: number;
}
export interface OperationStartedRecord extends RecordBase {
  type: "operation_started";
  sourceLeafId: string | null;
  intent:
    | {
        kind: "run";
        originalPrompt: AgentMessage[];
        initialMessages: ProvisionedEntry[];
        systemPromptOverride?: string;
        resumeData?: {
          [extensionId: string]: JsonValue;
        };
      }
    | {
        kind: "compaction";
        customInstructions?: string;
        resultEntryId: string;
      }
    | {
        kind: "navigation";
        targetId: string | null;
        summarize: boolean;
        customInstructions?: string;
        label?: string;
        summaryEntryId?: string;
      };
}
export interface AbortRequestedRecord extends RecordBase {
  type: "abort_requested";
  runId: string;
}
export interface OperationFinishedRecord extends RecordBase {
  type: "operation_finished";
  runId: string;
  outcome: "completed" | "aborted" | "failed" | "declined";
  error?: {
    code: string;
    message: string;
  };
}
export type CompactionReason = "manual" | "threshold" | "overflow";
export type StepAttemptRecord = RecordBase &
  (
    | {
        type: "step_attempt";
        runId: string;
        step: "assistant" | "branch_summary";
        attempt: number;
        resultEntryId: string;
        compactionReason?: never;
      }
    | {
        type: "step_attempt";
        runId: string;
        step: "compaction";
        attempt: number;
        resultEntryId: string;
        compactionReason: CompactionReason;
      }
  );
export interface ToolStartedRecord extends RecordBase {
  type: "tool_started";
  runId: string;
  assistantEntryId: string;
  toolIndex: number;
  toolCallId: string;
  toolName: string;
  effectiveArgs: {
    [key: string]: unknown;
  };
  resultEntryId: string;
  replay: "never" | "safe";
}
export type QueueEnqueuedRecord = RecordBase &
  (
    | {
        type: "queue_enqueued";
        queue: "steer" | "followUp";
        runId: string;
        target: ProvisionedEntry;
      }
    | {
        type: "queue_enqueued";
        queue: "nextRun";
        runId?: never;
        target: ProvisionedEntry;
      }
  );
export interface QueueCancelledRecord extends RecordBase {
  type: "queue_cancelled";
  runId?: string;
  entryId: string;
}
export interface WriteDeferredRecord extends RecordBase {
  type: "write_deferred";
  runId: string;
  target: ProvisionedEntry;
}
export type UsageRecord = RecordBase & {
  type: "usage";
  usage: Usage;
} & (
    | {
        cause: "assistant" | "compaction" | "branch_summary" | "deferred_fetch";
        runId: string;
        entryId: string;
        attempt: number;
        stopReason: SessionStopReason;
      }
    | {
        cause: "tool";
        runId: string;
        entryId: string;
        toolCallId: string;
      }
    | {
        cause: "hook";
        runId: string;
        entryId: string;
      }
    | {
        cause: "adjustment";
        runId?: string;
        entryId?: string;
        details?: JsonValue;
      }
  );
export type LaneRecord =
  | OperationStartedRecord
  | AbortRequestedRecord
  | OperationFinishedRecord
  | StepAttemptRecord
  | ToolStartedRecord
  | QueueEnqueuedRecord
  | QueueCancelledRecord
  | WriteDeferredRecord
  | UsageRecord;
export type NewRecord<TRecord extends LaneRecord = LaneRecord> = TRecord extends LaneRecord
  ? Omit<TRecord, "seq" | "timestamp">
  : never;
export type EntryOrder = "newestFirst" | "oldestFirst";
export interface EntryCursor {
  afterSeq: number;
}
export interface EntryQuery {
  type?: Entry["type"];
  customType?: string;
  order?: EntryOrder;
  limit?: number;
  cursor?: EntryCursor;
}
export interface BranchBounds {
  start?: string;
  stopAtType?: Entry["type"];
  stopAtId?: string;
}
export interface RecordQuery {
  lane?: string;
  type?: LaneRecord["type"];
  runId?: string;
  operationKind?: OperationStartedRecord["intent"]["kind"];
  afterSeq?: number;
  order?: EntryOrder;
  limit?: number;
}
export interface SessionMetadata {
  id: string;
  createdAt: number;
  parentSessionId?: string;
}
export interface SessionStats {
  messageCount: number;
  cachedTokens: number;
  uncachedTokens: number;
  totalTokens: number;
  costTotal: number;
}
export interface LanePointer {
  lane: string;
  leafId: string | null;
}
export type LogItem =
  | {
      kind: "entry";
      seq: number;
      entry: Entry;
    }
  | {
      kind: "record";
      seq: number;
      record: LaneRecord;
    }
  | {
      kind: "lane";
      seq: number;
      lane: string;
      leafId: string | null;
    }
  | {
      kind: "fact";
      seq: number;
      fact: "name";
      name: string;
    }
  | {
      kind: "fact";
      seq: number;
      fact: "label";
      targetId: string;
      label: string | undefined;
    };
export interface LogOptions {
  afterSeq?: number;
  limit?: number;
}
export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
  getMetadata(): Promise<TMetadata>;
  getLanes(): Promise<
    {
      lane: string;
      leafId: string | null;
    }[]
  >;
  createLane(lane: string, at: string | null): Promise<void>;
  moveLane(lane: string, to: string | null): Promise<void>;
  appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry>;
  appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord>;
  getEntry(id: string): Promise<Entry | undefined>;
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  findEntriesOnBranch(
    query: EntryQuery &
      BranchBounds & {
        start: string;
      },
  ): Promise<Entry[]>;
  findRecords<K extends LaneRecord["type"]>(
    query: RecordQuery & {
      type: K;
    },
  ): Promise<
    Extract<
      LaneRecord,
      {
        type: K;
      }
    >[]
  >;
  findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
  findOpenOperations(
    lane: string,
    options?: {
      limit?: number;
    },
  ): Promise<OperationStartedRecord[]>;
  getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
  getLabel(id: string): Promise<string | undefined>;
  setLabel(id: string, label: string | undefined): Promise<void>;
  getStats(): Promise<SessionStats>;
}
export interface SessionTree {
  getLeafId(): Promise<string | null>;
  getEntry(id: string): Promise<Entry | undefined>;
  getStats(): Promise<SessionStats>;
  getName(): Promise<string | undefined>;
  setName(name: string): Promise<void>;
  getLabel(targetId: string): Promise<string | undefined>;
  setLabel(targetId: string, label: string | undefined): Promise<void>;
  findEntries(query?: EntryQuery): Promise<Entry[]>;
  findEntry(query?: EntryQuery): Promise<Entry | undefined>;
  findEntriesOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry[]>;
  findEntryOnBranch(query?: EntryQuery & BranchBounds): Promise<Entry | undefined>;
  appendMessage(message: AgentMessage): Promise<string>;
  appendCustomEntry(customType: string, data?: unknown): Promise<string>;
}
export interface SessionCreateOptions {
  id?: string;
  parentSessionId?: string;
}
export type ForkOptions =
  | {
      scope?: "branch";
      entryId?: string;
      position?: "before" | "at";
    }
  | {
      scope: "tree";
    };
export interface SessionRepo<
  TMetadata extends SessionMetadata = SessionMetadata,
  TCreateOptions extends SessionCreateOptions = SessionCreateOptions,
  TListOptions = void,
> {
  create(options: TCreateOptions): Promise<Session<TMetadata>>;
  open(metadata: TMetadata): Promise<Session<TMetadata>>;
  list(options?: TListOptions): Promise<TMetadata[]>;
  delete(metadata: TMetadata): Promise<void>;
  fork(source: TMetadata, options: ForkOptions & TCreateOptions): Promise<Session<TMetadata>>;
}
export type SessionErrorCode =
  | "not_found"
  | "already_exists"
  | "invalid_entry"
  | "invalid_payload"
  | "invalid_lane"
  | "invalid_query"
  | "invalid_fork_target"
  | "storage";
export class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionError";
    this.code = code;
  }
}
