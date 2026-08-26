import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  type AgentMessage,
  buildSessionContext,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  JsonlSessionRepo,
  prepareCompaction,
  type Session,
  type SessionContext,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { CoremindCompactionDetails } from "./compaction-projection.js";
import { CoreMindError } from "./errors.js";
import type { CoreMindMessage } from "./public-message.js";

/** 会话 id 允许的字符（防路径穿越：仅字母/数字/连字符/下划线） */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function assertValidSessionId(sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new CoreMindError(
      "invalid_session_id",
      `会话 id 只能包含字母、数字、连字符与下划线（当前：${sessionId}）`,
    );
  }
}

export interface CoreMindSessionOptions {
  /** 会话存储目录 */
  dir: string;
  /** 会话文件名标识（--session <id>） */
  sessionId: string;
  /** 工作目录（存储元数据用） */
  cwd: string;
}

interface LegacySessionHeader {
  type: "session";
  version: 3;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  metadata?: Record<string, unknown>;
}

interface LegacySessionEntry extends Record<string, unknown> {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface LegacySessionDocument {
  header: LegacySessionHeader;
  entries: LegacySessionEntry[];
  source: string;
  sourceSha256: string;
}

interface MigrationMetadata {
  schemaVersion: 1;
  sourceFormat: 3;
  sourceSha256: string;
  complete: boolean;
  backupFile: string;
}

/** 仅供同模块故障注入测试使用，不从包入口导出。 */
export interface LegacySessionMigrationHooks {
  beforeTargetCommit?: () => void | Promise<void>;
  beforeAliasPublish?: () => void | Promise<void>;
}

/**
 * 会话（二期）：通过 CoreMind Adapter 使用版本化会话仓库。
 * - 落盘：每条消息一个树条目（Session.appendMessage）
 * - 恢复：buildContext() 生成"视图"——压缩条目自动替换旧历史，存储不变（非破坏）
 * - 压缩：P2b（shouldCompact + compact + appendCompaction）
 */
export class CoreMindSession {
  readonly isNew: boolean;
  readonly filePath: string;

  private constructor(
    private readonly session: Session,
    isNew: boolean,
    filePath: string,
  ) {
    this.isNew = isNew;
    this.filePath = filePath;
  }

  /** 打开或创建会话（已存在 → 恢复语义；不存在 → 新建） */
  static async open(opts: CoreMindSessionOptions): Promise<CoreMindSession> {
    assertValidSessionId(opts.sessionId);
    const publicPath = path.resolve(opts.dir, `${opts.sessionId}.jsonl`);
    return withSessionOpenLock(publicPath, async () => {
      const env = new NodeExecutionEnv({ cwd: opts.cwd });
      const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: path.resolve(opts.dir) });
      let metadata = (await repository.list({ cwd: opts.cwd })).find(
        (candidate) => candidate.id === opts.sessionId,
      );
      const hasPublicPath = await fileExists(publicPath);

      if (metadata === undefined && hasPublicPath) {
        metadata = await migrateLegacySession(opts, repository, publicPath);
      } else if (metadata !== undefined && hasPublicPath) {
        const linked = await pathsReferToSameFile(metadata.path, publicPath);
        if (!linked) {
          const legacy = await parseLegacySession(publicPath, opts.sessionId);
          const migration = readMigrationMetadata(metadata.metadata);
          if (migration === undefined || migration.sourceSha256 !== legacy.sourceSha256) {
            throw new CoreMindError(
              "session_layout_conflict",
              `会话公开路径与内部存储冲突：${publicPath}`,
            );
          }
          if (migration.complete) {
            await publishPublicAlias(metadata.path, publicPath);
          } else {
            metadata = await migrateLegacySession(opts, repository, publicPath);
          }
        }
      }

      const isNew = metadata === undefined;
      const session = metadata
        ? await repository.open(metadata)
        : await repository.create({ id: opts.sessionId, cwd: opts.cwd });
      const openedMetadata = await session.getMetadata();
      await ensurePublicSessionPath(openedMetadata.path, publicPath);
      return new CoreMindSession(session, isNew, publicPath);
    });
  }

  /** 会话文件是否存在（恢复前判断用） */
  static async exists(dir: string, sessionId: string, cwd: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    if (await fileExists(path.resolve(dir, `${sessionId}.jsonl`))) return true;
    const env = new NodeExecutionEnv({ cwd });
    const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: path.resolve(dir) });
    return (await repository.list({ cwd })).some((candidate) => candidate.id === sessionId);
  }

  /** 追加消息（每条一个树条目）；先深层删除 undefined 值字段（会话存储拒绝 undefined 值） */
  async appendMessages(messages: CoreMindMessage[]): Promise<void> {
    for (const message of messages) {
      await this.session.appendMessage(stripUndefined(message) as AgentMessage);
    }
  }

  /** 恢复视图：压缩条目替换旧历史后的上下文（存储不变——非破坏） */
  async buildContext(): Promise<SessionContext> {
    return buildSessionContext(await this.session.findEntriesOnBranch({ order: "oldestFirst" }));
  }

  /** 主 lane 全部条目（oldestFirst）——投影与请求重建用 */
  async branchEntries(): Promise<Awaited<ReturnType<Session["findEntriesOnBranch"]>>> {
    return this.session.findEntriesOnBranch({ order: "oldestFirst" });
  }

  /** 主 lane 当前 seq 水位（空树为 0）——Run 关联会话树的起始水位 */
  async currentSeq(): Promise<number> {
    const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
    return entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
  }

  /**
   * 追加 CoreMind 确定性压缩条目（追加不删除历史），返回完整条目。
   * 替换范围与指纹放 details；恢复视图按上游语义用摘要 + retainedTail 替换旧历史。
   */
  async appendCompaction(compaction: {
    summary: string;
    retainedTail: CoreMindMessage[];
    tokensBefore: number;
    details: CoremindCompactionDetails;
  }): Promise<Awaited<ReturnType<Session["appendEntry"]>>> {
    return this.session.appendEntry(
      {
        type: "compaction",
        id: this.session.idGenerator.next(),
        summary: compaction.summary,
        retainedTail: compaction.retainedTail as AgentMessage[],
        tokensBefore: compaction.tokensBefore,
        details: compaction.details,
      },
      "main",
    );
  }

  /**
   * 自动压缩：上下文超预算时生成 LLM 摘要并追加压缩条目（存储不变——非破坏）。
   * 返回是否执行了压缩。
   */
  async maybeCompact(
    models: Models,
    model: Model<any>,
    contextWindow: number,
    settings: Partial<{
      enabled: boolean;
      reserveTokens: number;
      keepRecentTokens: number;
    }> = {},
  ): Promise<boolean> {
    const merged = { ...DEFAULT_COMPACTION_SETTINGS, ...settings };
    if (!merged.enabled) return false;
    const entries = await this.session.findEntriesOnBranch({ order: "oldestFirst" });
    const tokens = estimateContextTokens(buildSessionContext(entries).messages).tokens;
    // 预算公式（上游实现）：tokens > contextWindow − reserveTokens 时触发
    if (!shouldCompact(tokens, contextWindow, merged)) return false;
    const prep = prepareCompaction(entries, merged);
    if (!prep.ok || !prep.value) return false;
    const result = await compact(prep.value, models, model);
    if (!result.ok) return false;
    await this.session.appendEntry(
      {
        type: "compaction",
        id: this.session.idGenerator.next(),
        summary: result.value.summary,
        retainedTail: result.value.retainedTail,
        tokensBefore: result.value.tokensBefore,
        ...(result.value.details === undefined ? {} : { details: result.value.details }),
        ...(result.value.usage === undefined ? {} : { usage: result.value.usage }),
      },
      "main",
    );
    return true;
  }
}

/**
 * 将旧版直接 JSONL 会话迁移到版本化仓库。
 * 迁移先保存逐字节备份，再原子提交目标；公开路径最后切换，因此失败不会覆盖原文件。
 */
export async function migrateLegacySession(
  opts: CoreMindSessionOptions,
  repository: JsonlSessionRepo,
  publicPath: string,
  hooks: LegacySessionMigrationHooks = {},
): Promise<Awaited<ReturnType<JsonlSessionRepo["list"]>>[number]> {
  const legacy = await parseLegacySession(publicPath, opts.sessionId);
  const backupPath = `${publicPath}.v3.backup`;
  await ensureLegacyBackup(backupPath, legacy.source);

  let metadata = (await repository.list({ cwd: opts.cwd })).find(
    (candidate) => candidate.id === opts.sessionId,
  );
  if (metadata === undefined) {
    const created = await repository.create({
      id: opts.sessionId,
      cwd: opts.cwd,
      metadata: {
        coremindMigration: { ...migrationMetadata(legacy.sourceSha256, backupPath, false) },
      },
    });
    metadata = await created.getMetadata();
  }

  const existingMigration = readMigrationMetadata(metadata.metadata);
  if (existingMigration !== undefined && existingMigration.sourceSha256 !== legacy.sourceSha256) {
    throw new CoreMindError(
      "session_migration_conflict",
      `会话 ${opts.sessionId} 的迁移源与已有候选不一致`,
    );
  }

  if (existingMigration?.complete !== true) {
    const migratedText = convertLegacySession(legacy, metadata.createdAt, opts.cwd, backupPath);
    await hooks.beforeTargetCommit?.();
    await writeTextAtomically(metadata.path, migratedText);
    metadata = (await repository.list({ cwd: opts.cwd })).find(
      (candidate) => candidate.id === opts.sessionId,
    );
    if (metadata === undefined || readMigrationMetadata(metadata.metadata)?.complete !== true) {
      throw new CoreMindError(
        "session_migration_failed",
        `会话 ${opts.sessionId} 的迁移目标校验失败`,
      );
    }
    await repository.open(metadata);
  }

  await hooks.beforeAliasPublish?.();
  await publishPublicAlias(metadata.path, publicPath);
  return metadata;
}

async function ensurePublicSessionPath(storagePath: string, publicPath: string): Promise<void> {
  if (await fileExists(publicPath)) {
    const [storageInfo, publicInfo] = await Promise.all([stat(storagePath), stat(publicPath)]);
    if (storageInfo.dev !== publicInfo.dev || storageInfo.ino !== publicInfo.ino) {
      throw new CoreMindError(
        "session_layout_conflict",
        `会话公开路径与内部存储冲突：${publicPath}`,
      );
    }
    return;
  }

  try {
    await link(storagePath, publicPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CoreMindError(
      "session_alias_failed",
      `无法创建稳定会话路径 ${publicPath}：${detail}`,
    );
  }
}

async function pathsReferToSameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftInfo, rightInfo] = await Promise.all([stat(left), stat(right)]);
    return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino;
  } catch {
    return false;
  }
}

async function withSessionOpenLock<T>(publicPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(publicPath), { recursive: true });
  const lockPath = `${publicPath}.open.lock`;
  const deadline = Date.now() + 2_000;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new CoreMindError(
          "session_open_locked",
          `会话 ${path.basename(publicPath)} 正由另一进程打开`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

async function parseLegacySession(
  file: string,
  expectedSessionId: string,
): Promise<LegacySessionDocument> {
  const source = await readFile(file, "utf8");
  const lines = source.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    throw new CoreMindError("session_migration_invalid", `旧会话缺少头记录：${file}`);
  }
  const headerValue = parseJsonObject(lines[0]!, file, 1);
  if (
    headerValue.type !== "session" ||
    headerValue.version !== 3 ||
    typeof headerValue.id !== "string" ||
    typeof headerValue.timestamp !== "string" ||
    typeof headerValue.cwd !== "string"
  ) {
    throw new CoreMindError("session_migration_invalid", `旧会话头记录无效：${file}`);
  }
  if (headerValue.id !== expectedSessionId) {
    throw new CoreMindError(
      "session_migration_invalid",
      `旧会话 id ${headerValue.id} 与请求的 ${expectedSessionId} 不一致`,
    );
  }
  if (headerValue.parentSession !== undefined && typeof headerValue.parentSession !== "string") {
    throw new CoreMindError("session_migration_invalid", `旧会话 parentSession 无效：${file}`);
  }
  if (
    headerValue.metadata !== undefined &&
    (!isObject(headerValue.metadata) || Array.isArray(headerValue.metadata))
  ) {
    throw new CoreMindError("session_migration_invalid", `旧会话 metadata 无效：${file}`);
  }
  const entries = lines.slice(1).map((line, index) => {
    const value = parseJsonObject(line, file, index + 2);
    if (
      typeof value.type !== "string" ||
      typeof value.id !== "string" ||
      (value.parentId !== null && typeof value.parentId !== "string") ||
      typeof value.timestamp !== "string"
    ) {
      throw new CoreMindError(
        "session_migration_invalid",
        `旧会话第 ${index + 2} 行条目无效：${file}`,
      );
    }
    return value as LegacySessionEntry;
  });
  return {
    header: headerValue as unknown as LegacySessionHeader,
    entries,
    source,
    sourceSha256: createHash("sha256").update(source, "utf8").digest("hex"),
  };
}

function convertLegacySession(
  legacy: LegacySessionDocument,
  createdAt: number,
  cwd: string,
  backupPath: string,
): string {
  const header = {
    kind: "header",
    version: 4,
    id: legacy.header.id,
    createdAt,
    cwd: path.resolve(cwd),
    ...(legacy.header.parentSession === undefined
      ? {}
      : { legacyParentSessionPath: legacy.header.parentSession }),
    metadata: {
      ...(legacy.header.metadata ?? {}),
      coremindMigration: migrationMetadata(legacy.sourceSha256, backupPath, true),
    },
  };
  const mutations: Record<string, unknown>[] = [];
  const aliases = new Map<string, string | null>();
  let sequence = 0;

  const resolveId = (value: string | null): string | null => {
    let current = value;
    const seen = new Set<string>();
    while (current !== null && aliases.has(current)) {
      if (seen.has(current)) {
        throw new CoreMindError("session_migration_invalid", `旧会话存在循环别名：${current}`);
      }
      seen.add(current);
      current = aliases.get(current) ?? null;
    }
    return current;
  };

  for (const entry of legacy.entries) {
    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new CoreMindError("session_migration_invalid", `旧会话条目 ${entry.id} 的时间戳无效`);
    }
    const parentId = resolveId(entry.parentId);
    sequence += 1;
    switch (entry.type) {
      case "leaf": {
        const targetId =
          entry.targetId === null ? null : resolveRequiredId(entry.targetId, entry.id);
        aliases.set(entry.id, targetId);
        mutations.push({ kind: "lane", seq: sequence, lane: "main", leafId: targetId });
        break;
      }
      case "label": {
        const targetId = resolveRequiredId(entry.targetId, entry.id);
        aliases.set(entry.id, parentId);
        mutations.push({
          kind: "fact",
          seq: sequence,
          fact: "label",
          targetId,
          ...(typeof entry.label === "string" && entry.label.trim().length > 0
            ? { label: entry.label.trim() }
            : {}),
        });
        break;
      }
      case "session_info": {
        if (typeof entry.name !== "string") {
          throw new CoreMindError("session_migration_invalid", `旧会话名称条目 ${entry.id} 无效`);
        }
        aliases.set(entry.id, parentId);
        mutations.push({
          kind: "fact",
          seq: sequence,
          fact: "name",
          name: entry.name.replace(/[\r\n]+/g, " ").trim(),
        });
        break;
      }
      case "message":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "message",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          message: entry.message,
        });
        break;
      case "model_change":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "model_change",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          provider: entry.provider,
          modelId: entry.modelId,
        });
        break;
      case "thinking_level_change":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "thinking_level_change",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          thinkingLevel: entry.thinkingLevel,
        });
        break;
      case "active_tools_change":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "active_tools_change",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          activeToolNames: entry.activeToolNames,
        });
        break;
      case "compaction":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "compaction",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          summary: entry.summary,
          retainedTail: Array.isArray(entry.retainedTail) ? entry.retainedTail : [],
          tokensBefore: entry.tokensBefore,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        });
        break;
      case "branch_summary":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "branch_summary",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          fromId: resolveRequiredId(entry.fromId, entry.id),
          summary: entry.summary,
          ...(entry.details === undefined ? {} : { details: entry.details }),
          ...(entry.usage === undefined ? {} : { usage: entry.usage }),
        });
        break;
      case "custom":
        mutations.push({
          kind: "entry",
          lane: "main",
          type: "custom",
          id: entry.id,
          seq: sequence,
          parentId,
          timestamp,
          customType: entry.customType,
          ...(entry.data === undefined ? {} : { data: entry.data }),
        });
        break;
      default:
        throw new CoreMindError(
          "session_migration_unsupported",
          `旧会话条目类型 ${entry.type} 无法无损迁移；原文件未修改`,
        );
    }
  }

  return `${[header, ...mutations].map((item) => JSON.stringify(item)).join("\n")}\n`;
}

function resolveRequiredId(value: unknown, ownerId: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoreMindError("session_migration_invalid", `旧会话条目 ${ownerId} 引用了无效 id`);
  }
  return value;
}

function migrationMetadata(
  sourceSha256: string,
  backupPath: string,
  complete: boolean,
): MigrationMetadata {
  return {
    schemaVersion: 1,
    sourceFormat: 3,
    sourceSha256,
    complete,
    backupFile: path.basename(backupPath),
  };
}

function readMigrationMetadata(metadata: unknown): MigrationMetadata | undefined {
  if (!isObject(metadata) || !isObject(metadata.coremindMigration)) return undefined;
  const value = metadata.coremindMigration;
  if (
    value.schemaVersion !== 1 ||
    value.sourceFormat !== 3 ||
    typeof value.sourceSha256 !== "string" ||
    typeof value.complete !== "boolean" ||
    typeof value.backupFile !== "string"
  ) {
    return undefined;
  }
  return value as unknown as MigrationMetadata;
}

async function ensureLegacyBackup(backupPath: string, source: string): Promise<void> {
  if (await fileExists(backupPath)) {
    const existing = await readFile(backupPath, "utf8");
    if (existing !== source) {
      throw new CoreMindError(
        "session_migration_conflict",
        `旧会话备份与当前源文件不一致：${backupPath}`,
      );
    }
    return;
  }
  const temporary = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: "utf8", flag: "wx" });
    await rename(temporary, backupPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeTextAtomically(destination: string, text: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function publishPublicAlias(storagePath: string, publicPath: string): Promise<void> {
  if (await pathsReferToSameFile(storagePath, publicPath)) return;
  const temporary = `${publicPath}.${process.pid}.${randomUUID()}.alias`;
  try {
    await link(storagePath, temporary);
    await unlink(publicPath).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    await rename(temporary, publicPath);
  } catch (error) {
    if (!(await fileExists(publicPath))) {
      const backupPath = `${publicPath}.v3.backup`;
      if (await fileExists(backupPath)) await copyFile(backupPath, publicPath);
    }
    throw new CoreMindError(
      "session_alias_failed",
      `无法发布稳定会话路径 ${publicPath}：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function parseJsonObject(line: string, file: string, lineNumber: number): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new CoreMindError(
      "session_migration_invalid",
      `旧会话 ${file} 第 ${lineNumber} 行不是有效 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(value)) {
    throw new CoreMindError(
      "session_migration_invalid",
      `旧会话 ${file} 第 ${lineNumber} 行不是对象`,
    );
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 深层删除值为 undefined 的字段。
 * 上游 toolResult 消息可能携带 undefined 的 details/usage 字段：JSON.stringify 会省略，
 * 但会话树存储的 assertJsonSerializable 拒绝 undefined 值字段，落盘前必须清理。
 */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = stripUndefined(item);
    }
    return result as T;
  }
  return value;
}
