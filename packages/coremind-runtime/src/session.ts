import path from "node:path";
import {
  type AgentMessage,
  buildSessionContext,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  JsonlSessionStorage,
  prepareCompaction,
  Session,
  type SessionContext,
  shouldCompact,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type { Model, Models } from "@earendil-works/pi-ai";
import { CoreMindError } from "./errors.js";

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

/**
 * 会话（二期）：基于上游 pi-agent-core 的会话树存储。
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
    const env = new NodeExecutionEnv({ cwd: opts.cwd });
    const filePath = path.join(opts.dir, `${opts.sessionId}.jsonl`);
    // 注意：env.exists 返回 Result（{ok:false,error} 也是 truthy），必须解包
    const existsResult = await env.exists(filePath);
    const exists = existsResult.ok ? existsResult.value : false;
    const storage = exists
      ? await JsonlSessionStorage.open(env, filePath)
      : await JsonlSessionStorage.create(env, filePath, {
          cwd: opts.cwd,
          sessionId: opts.sessionId,
        });
    return new CoreMindSession(new Session(storage), !exists, filePath);
  }

  /** 会话文件是否存在（恢复前判断用） */
  static async exists(dir: string, sessionId: string, cwd: string): Promise<boolean> {
    assertValidSessionId(sessionId);
    const env = new NodeExecutionEnv({ cwd });
    const result = await env.exists(path.join(dir, `${sessionId}.jsonl`));
    return result.ok ? result.value : false;
  }

  /** 追加消息（每条一个树条目） */
  async appendMessages(messages: AgentMessage[]): Promise<void> {
    for (const message of messages) {
      await this.session.appendMessage(message);
    }
  }

  /** 恢复视图：压缩条目替换旧历史后的上下文（存储不变——非破坏） */
  async buildContext(): Promise<SessionContext> {
    return this.session.buildContext();
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
    const entries = await this.session.getEntries();
    const tokens = estimateContextTokens(buildSessionContext(entries).messages).tokens;
    // 预算公式（上游实现）：tokens > contextWindow − reserveTokens 时触发
    if (!shouldCompact(tokens, contextWindow, merged)) return false;
    const prep = prepareCompaction(entries, merged);
    if (!prep.ok || !prep.value) return false;
    const result = await compact(prep.value, models, model);
    if (!result.ok) return false;
    await this.session.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
    );
    return true;
  }
}
