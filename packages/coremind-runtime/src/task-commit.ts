import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { Ajv, type ValidateFunction } from "ajv";
import { canonicalJson } from "./canonical-json.js";
import { CoreMindError } from "./errors.js";
import {
  FileRunStore,
  type RunStateRecord,
  type RunStore,
  type RunStoreDurabilityBoundary,
} from "./run-state.js";
import { assertJsonSerializable } from "./session-v4/session/session.js";
import type { JsonValue } from "./session-v4/session/types.js";
import {
  acquireSessionWriteLease,
  assertSessionWriteLease,
  type SessionWriteLease,
} from "./session-write-lease.js";

export interface TaskCheckpoint {
  type: string;
  version: number;
  phase: string;
  checkpoint: JsonValue;
}

export interface TaskDocument {
  id: string;
  type: string;
  version: number;
  value: JsonValue;
}

/** 当前基础合同只保存文本对话；不执行消息或还原 JS 调用栈。 */
export interface TaskConversationEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface TaskCommit {
  schemaVersion: 1;
  commitId: string;
  expectedRevision: number;
  taskId: string;
  task: TaskCheckpoint;
  documents: TaskDocument[];
  entries: TaskConversationEntry[];
}

export interface TaskDocumentSchema {
  type: string;
  version: number;
  schema: Record<string, unknown>;
}

export interface TaskCommitProjection {
  revision: number;
  tasks: Record<string, TaskCheckpoint>;
  documents: Record<string, TaskDocument>;
  entries: TaskConversationEntry[];
}

export interface TaskCommitReceipt {
  commitId: string;
  revision: number;
  durabilityBoundary: RunStoreDurabilityBoundary;
}

export interface TaskCommitSessionOptions {
  workspace: string;
  sessionId: string;
  documentSchemas: readonly TaskDocumentSchema[];
  /** 受信任宿主 Adapter；必须提供 critical 原子单记录提交及进程崩溃持久性。 */
  store?: (directory: string) => RunStore;
}

interface TaskCommitFact {
  workspaceKey: string;
  sessionId: string;
  schemas: Record<string, string>;
  commit: TaskCommit;
}

interface DocumentValidator {
  validate: ValidateFunction;
  fingerprint: string;
}

const MAX_COMMIT_BYTES = 1024 * 1024;
const ID = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$" } as const;
const VERSION = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const validator = new Ajv({ logger: false, strict: true, ownProperties: true });
const validateCommit = validator.compile({
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "commitId",
    "expectedRevision",
    "taskId",
    "task",
    "documents",
    "entries",
  ],
  properties: {
    schemaVersion: { const: 1 },
    commitId: ID,
    expectedRevision: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    taskId: ID,
    task: {
      type: "object",
      additionalProperties: false,
      required: ["type", "version", "phase", "checkpoint"],
      properties: { type: ID, version: VERSION, phase: ID, checkpoint: {} },
    },
    documents: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "version", "value"],
        properties: { id: ID, type: ID, version: VERSION, value: {} },
      },
    },
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "role", "text"],
        properties: { id: ID, role: { enum: ["user", "assistant"] }, text: { type: "string" } },
      },
    },
  },
});

/**
 * 显式任务会话的唯一提交事实；尚不属于普通 ChatSession 或任务调度器。
 * 每个提交把 checkpoint、document 和 entry 放在一个 critical 原子记录中。
 */
export class TaskCommitSession {
  readonly durabilityBoundary: RunStoreDurabilityBoundary;
  private projection: TaskCommitProjection = { revision: 0, tasks: {}, documents: {}, entries: [] };
  private readonly commits = new Map<string, { fingerprint: string; receipt: TaskCommitReceipt }>();
  private readonly entryIds = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private unavailable = false;
  private closing?: Promise<void>;

  private constructor(
    private readonly workspace: string,
    private readonly sessionId: string,
    private readonly directory: string,
    private readonly lease: SessionWriteLease,
    private readonly store: RunStore,
    private readonly schemas: Map<string, DocumentValidator>,
  ) {
    this.durabilityBoundary = store.durabilityBoundary!;
  }

  static async open(options: TaskCommitSessionOptions): Promise<TaskCommitSession> {
    if (
      typeof options.sessionId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(options.sessionId)
    ) {
      throw new CoreMindError("invalid_session_id", "任务会话需要有效的 sessionId");
    }
    const schemas = compileSchemas(options.documentSchemas);
    const workspace = canonicalPath(await realpath(options.workspace));
    const directory = await taskDirectory(workspace, options.sessionId);
    const lease = await acquireSessionWriteLease(directory, "commits");
    try {
      const store =
        options.store?.(directory) ?? new FileRunStore(directory, { repairTornTail: false });
      if (
        store.atomicCriticalCommit !== true ||
        !store.supportedDurability?.includes("critical") ||
        !["process_crash", "system_crash", "power_loss"].includes(store.durabilityBoundary ?? "") ||
        typeof store.commit !== "function"
      ) {
        throw new CoreMindError(
          "durability_unsupported",
          "任务存储必须声明 critical 原子提交与持久边界",
        );
      }
      if (
        store.pathFor &&
        canonicalPath(path.resolve(store.pathFor("commits"))) !== lease.sessionPath
      ) {
        throw new CoreMindError("policy_denied", "任务 Store 文件必须绑定当前工作区与任务会话");
      }
      const session = new TaskCommitSession(
        workspace,
        options.sessionId,
        directory,
        lease,
        store,
        schemas,
      );
      await session.assertStorage();
      for (const record of await store.read("commits")) session.restore(record);
      return session;
    } catch (error) {
      try {
        await lease.release();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "任务会话打开与解锁均失败");
      }
      throw error;
    }
  }

  snapshot(): TaskCommitProjection {
    this.assertAvailable();
    return structuredClone(this.projection);
  }

  async commit(input: TaskCommit): Promise<TaskCommitReceipt> {
    this.assertAvailable();
    const commit = copyJson(input);
    const schemas = this.validate(commit);
    const fingerprint = canonicalJson(commit);
    const operation = this.tail.then(async () => {
      // close 只关闭准入；已接收提交必须先收敛，不能提前释放写租约。
      if (this.unavailable) throw unavailable();
      const existing = this.commits.get(commit.commitId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw conflict("commitId 已绑定不同内容");
        return structuredClone(existing.receipt);
      }
      if (commit.expectedRevision !== this.projection.revision)
        throw conflict("任务提交 revision 冲突");
      for (const entry of commit.entries) {
        if (this.entryIds.has(entry.id)) throw conflict("对话 entry id 已存在");
      }
      const record: RunStateRecord = {
        version: 1,
        runId: "commits",
        sequence: this.projection.revision + 1,
        eventId: commit.commitId,
        timestamp: new Date().toISOString(),
        kind: "task_commit",
        payload: copyJson({
          workspaceKey: hash(this.workspace),
          sessionId: this.sessionId,
          schemas,
          commit,
        } satisfies TaskCommitFact),
      };
      try {
        await this.assertStorage();
        const acknowledgement = await this.store.commit!(record, "critical");
        if (
          acknowledgement.requested !== "critical" ||
          acknowledgement.achieved !== "critical" ||
          acknowledgement.boundary !== this.durabilityBoundary
        ) {
          throw new CoreMindError("durability_barrier_failed", "任务提交未取得承诺的持久回执");
        }
        // 只有持久提交成功才发布整个新投影；I/O 结果未知时旧 holder 不再继续操作。
        return this.publish(commit, fingerprint);
      } catch (error) {
        this.unavailable = true;
        throw error;
      }
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  close(): Promise<void> {
    this.closing ??= this.tail.then(() => this.lease.release());
    return this.closing;
  }

  private assertAvailable(): void {
    if (this.closing || this.unavailable) throw unavailable();
  }

  private async assertStorage(): Promise<void> {
    if ((await taskDirectory(this.workspace, this.sessionId)) !== this.directory) {
      throw new CoreMindError("policy_denied", "任务存储目录身份变化");
    }
    await assertSessionWriteLease(this.lease, this.lease.sessionPath);
    try {
      const file = await lstat(this.lease.sessionPath);
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) {
        throw new CoreMindError("policy_denied", "任务事实文件不得使用链接或非普通文件");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private validate(commit: TaskCommit): Record<string, string> {
    if (!validateCommit(commit)) throw invalid("任务提交字段或 schemaVersion 无效");
    const fingerprints: Record<string, string> = {};
    const documentIds = new Set<string>();
    const entryIds = new Set<string>();
    for (const document of commit.documents) {
      const key = schemaKey(document.type, document.version);
      const schema = this.schemas.get(key);
      if (!schema?.validate(document.value)) throw invalid("document 不符合已注册 Schema");
      if (documentIds.has(document.id)) throw invalid("单次提交不能重复更新同一 document");
      documentIds.add(document.id);
      fingerprints[key] = schema.fingerprint;
    }
    for (const entry of commit.entries) {
      if (entryIds.has(entry.id)) throw invalid("单次提交不能重复 entry id");
      entryIds.add(entry.id);
    }
    return fingerprints;
  }

  private restore(record: RunStateRecord): void {
    try {
      const fact = copyJson(record.payload) as unknown as TaskCommitFact;
      if (
        record.version !== 1 ||
        record.kind !== "task_commit" ||
        record.runId !== "commits" ||
        record.sequence !== this.projection.revision + 1 ||
        !fact ||
        fact.workspaceKey !== hash(this.workspace) ||
        fact.sessionId !== this.sessionId ||
        !fact.commit ||
        record.eventId !== fact.commit.commitId ||
        fact.commit.expectedRevision !== this.projection.revision ||
        this.commits.has(fact.commit.commitId)
      )
        throw invalid("任务事实身份或顺序不符");
      const schemas = this.validate(fact.commit);
      if (canonicalJson(schemas) !== canonicalJson(fact.schemas))
        throw invalid("document Schema 身份发生变化");
      for (const entry of fact.commit.entries) {
        if (this.entryIds.has(entry.id)) throw invalid("任务事实重复 entry id");
      }
      this.publish(fact.commit, canonicalJson(fact.commit));
    } catch {
      throw new CoreMindError(
        "task_store_corrupt",
        "任务事实损坏、版本不支持或 Schema/工作区身份不符",
      );
    }
  }

  private publish(commit: TaskCommit, fingerprint: string): TaskCommitReceipt {
    const revision = this.projection.revision + 1;
    const receipt = {
      commitId: commit.commitId,
      revision,
      durabilityBoundary: this.durabilityBoundary,
    };
    this.projection = {
      revision,
      tasks: { ...this.projection.tasks, [commit.taskId]: structuredClone(commit.task) },
      documents: {
        ...this.projection.documents,
        ...Object.fromEntries(
          commit.documents.map((document) => [document.id, structuredClone(document)]),
        ),
      },
      entries: [...this.projection.entries, ...structuredClone(commit.entries)],
    };
    for (const entry of commit.entries) this.entryIds.add(entry.id);
    this.commits.set(commit.commitId, { fingerprint, receipt });
    return structuredClone(receipt);
  }
}

function compileSchemas(
  definitions: readonly TaskDocumentSchema[],
): Map<string, DocumentValidator> {
  const schemas = new Map<string, DocumentValidator>();
  if (!Array.isArray(definitions)) throw invalid("documentSchemas 必须为数组");
  for (const definition of definitions) {
    const item = copyJson(definition);
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.type !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(item.type) ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      !item.schema ||
      typeof item.schema !== "object" ||
      Array.isArray(item.schema)
    )
      throw invalid("document Schema 定义无效");
    const key = schemaKey(item.type, item.version);
    if (schemas.has(key)) throw invalid("document Schema 身份重复");
    try {
      // 每份 Schema 独立编译，避免不同任务定义的 $id 相互污染；不解析网络引用。
      const validate = new Ajv({ logger: false, strict: true, ownProperties: true }).compile(
        item.schema,
      );
      if ("$async" in validate && validate.$async) throw invalid("document Schema 不允许异步验证");
      schemas.set(key, { validate, fingerprint: hash(canonicalJson(item.schema)) });
    } catch {
      throw invalid("document Schema 必须为可同步验证的 JSON Schema draft-07");
    }
  }
  return schemas;
}

function copyJson<T>(value: T): T {
  try {
    assertJsonSerializable(value);
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text, "utf8") > MAX_COMMIT_BYTES) throw invalid("任务提交超过 1 MiB");
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof CoreMindError) throw error;
    throw invalid("任务提交必须为有限、无访问器且可序列化的 JSON");
  }
}

async function taskDirectory(workspace: string, sessionId: string): Promise<string> {
  if (canonicalPath(await realpath(workspace)) !== workspace) {
    throw new CoreMindError("policy_denied", "任务工作区身份变化");
  }
  let directory = workspace;
  for (const name of [".coremind", "tasks", hash(sessionId)]) {
    directory = path.join(directory, name);
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      canonicalPath(await realpath(directory)) !== directory
    ) {
      throw new CoreMindError("policy_denied", "任务存储目录不能是符号链接或越出工作区");
    }
  }
  return directory;
}

function canonicalPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function schemaKey(type: string, version: number): string {
  return `${type}@${version}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string): CoreMindError {
  return new CoreMindError("task_commit_invalid", message);
}

function conflict(message: string): CoreMindError {
  return new CoreMindError("task_commit_conflict", message);
}

function unavailable(): CoreMindError {
  return new CoreMindError(
    "task_store_unavailable",
    "任务会话已关闭或 I/O 结果未知，请重新打开并核对事实",
  );
}
