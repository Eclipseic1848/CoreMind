import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createUnifiedDiff,
  DiffLimitError,
  type ResolvedToolCapability,
  resolveToolCapability,
} from "coremind-tools";
import { CoreMindError } from "./errors.js";

export interface CheckpointRecord {
  version: 1;
  checkpointId: string;
  runId: string;
  operationId?: string;
  toolCallId?: string;
  idempotencyKey?: string;
  timestamp: string;
  tool: string;
  reversible: boolean;
  targetPath?: string;
  existed?: boolean;
  beforeSha256?: string;
  afterExisted?: boolean;
  afterSha256?: string;
  reason?: string;
  snapshotFile: string;
}

interface StoredCheckpoint extends CheckpointRecord {
  contentBase64?: string;
}

export interface CheckpointDiff {
  checkpointId: string;
  targetPath?: string;
  changed: boolean;
  beforeSha256?: string;
  afterSha256?: string;
  beforeText?: string;
  afterText?: string;
  unifiedDiff?: string;
  reversible: boolean;
  reason?: string;
}

export interface CheckpointManagerOptions {
  cwd: string;
  rootDir: string;
  runId: string;
  maxFileBytes?: number;
}

/** 修改工具的本地快照、diff 与显式恢复入口。 */
export class CheckpointManager {
  readonly records: CheckpointRecord[] = [];
  private readonly maxFileBytes: number;

  constructor(private readonly options: CheckpointManagerOptions) {
    this.maxFileBytes = options.maxFileBytes ?? 10 * 1024 * 1024;
  }

  async capture(
    tool: string,
    args: unknown,
    correlation: {
      operationId?: string;
      toolCallId?: string;
      idempotencyKey?: string;
      capability?: ResolvedToolCapability;
    } = {},
  ): Promise<CheckpointRecord | undefined> {
    const capability = correlation.capability ?? resolveToolCapability({ tool });
    if (capability.checkpoint === "none") return undefined;
    if (capability.checkpoint === "unsupported") {
      return this.persist({
        tool,
        ...correlation,
        reversible: false,
        reason: "任意命令或自定义工具可能产生工作区外副作用，无法保证自动回退",
      });
    }

    const target = pathArgument(args);
    if (!target) {
      throw new CoreMindError("checkpoint_failed", `工具 ${tool} 缺少可识别的 path 参数`);
    }
    const targetPath = await this.safeTargetPath(target);
    let content: Buffer | undefined;
    let existed = true;
    try {
      content = await readFile(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") existed = false;
      else {
        throw new CoreMindError(
          "checkpoint_failed",
          `读取修改前文件失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (content && content.byteLength > this.maxFileBytes) {
      throw new CoreMindError(
        "checkpoint_too_large",
        `文件 ${target} 大于检查点上限 ${this.maxFileBytes} 字节，已阻止修改`,
      );
    }
    return this.persist({
      tool,
      ...correlation,
      reversible: true,
      targetPath,
      existed,
      ...(content
        ? { beforeSha256: sha256(content), contentBase64: content.toString("base64") }
        : {}),
    });
  }

  async diff(checkpointId: string): Promise<CheckpointDiff> {
    const stored = await this.load(checkpointId);
    if (!stored.reversible || !stored.targetPath) {
      return {
        checkpointId,
        changed: false,
        reversible: false,
        reason: stored.reason,
      };
    }
    let after: Buffer | undefined;
    try {
      after = await readFile(stored.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const before = stored.contentBase64 ? Buffer.from(stored.contentBase64, "base64") : undefined;
    if ((before?.byteLength ?? 0) + (after?.byteLength ?? 0) > this.maxFileBytes) {
      throw new CoreMindError(
        "checkpoint_too_large",
        `检查点 diff 输入大于 ${this.maxFileBytes} 字节上限`,
      );
    }
    const beforeSha256 = before ? sha256(before) : undefined;
    const afterSha256 = after ? sha256(after) : undefined;
    const relativePath =
      path.relative(this.options.cwd, stored.targetPath) || path.basename(stored.targetPath);
    let unifiedDiff: string;
    try {
      unifiedDiff = createUnifiedDiff(
        before?.toString("utf8") ?? "",
        after?.toString("utf8") ?? "",
        {
          oldPath: stored.existed ? relativePath : "/dev/null",
          newPath: after ? relativePath : "/dev/null",
          maxInputBytes: this.maxFileBytes,
        },
      );
    } catch (error) {
      if (error instanceof DiffLimitError) {
        throw new CoreMindError("checkpoint_too_large", error.message);
      }
      throw error;
    }
    return {
      checkpointId,
      targetPath: stored.targetPath,
      changed: stored.existed ? beforeSha256 !== afterSha256 : after !== undefined,
      beforeSha256,
      afterSha256,
      ...(before ? { beforeText: before.toString("utf8") } : {}),
      ...(after ? { afterText: after.toString("utf8") } : {}),
      unifiedDiff,
      reversible: true,
    };
  }

  /** 工具执行结束后记录预期文件状态，供恢复时识别后续人工或并发修改。 */
  async markApplied(checkpointId: string): Promise<void> {
    const stored = await this.load(checkpointId);
    if (!stored.reversible || !stored.targetPath) return;
    await this.safeTargetPath(stored.targetPath);
    const after = await readOptionalFile(stored.targetPath);
    stored.afterExisted = after !== undefined;
    if (after) stored.afterSha256 = sha256(after);
    else delete stored.afterSha256;
    await writeFile(stored.snapshotFile, `${JSON.stringify(stored)}\n`, "utf8");

    const record = this.records.find((item) => item.checkpointId === checkpointId);
    if (record) {
      record.afterExisted = stored.afterExisted;
      if (stored.afterSha256) record.afterSha256 = stored.afterSha256;
      else delete record.afterSha256;
    }
  }

  /** 仅在调用方显式请求时恢复单个目标文件。 */
  async restore(checkpointId: string): Promise<void> {
    const stored = await this.load(checkpointId);
    if (!stored.reversible || !stored.targetPath) {
      throw new CoreMindError(
        "checkpoint_not_reversible",
        stored.reason ?? `检查点 ${checkpointId} 不可自动恢复`,
      );
    }
    await this.safeTargetPath(stored.targetPath);
    if (stored.afterExisted === undefined) {
      throw new CoreMindError(
        "checkpoint_conflict",
        `检查点 ${checkpointId} 缺少工具执行后的文件状态，无法安全恢复`,
      );
    }
    const current = await readOptionalFile(stored.targetPath);
    const currentExists = current !== undefined;
    const currentSha256 = current ? sha256(current) : undefined;
    if (
      currentExists !== stored.afterExisted ||
      (currentExists && currentSha256 !== stored.afterSha256)
    ) {
      throw new CoreMindError(
        "checkpoint_conflict",
        `文件 ${stored.targetPath} 已在工具执行后再次变化，已拒绝覆盖`,
      );
    }
    if (stored.existed) {
      const content = Buffer.from(stored.contentBase64 ?? "", "base64");
      await mkdir(path.dirname(stored.targetPath), { recursive: true });
      await writeFile(stored.targetPath, content);
      return;
    }
    try {
      await unlink(stored.targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(
    value: Omit<
      StoredCheckpoint,
      "version" | "checkpointId" | "runId" | "timestamp" | "snapshotFile"
    >,
  ): Promise<CheckpointRecord> {
    const checkpointId = randomUUID();
    const snapshotFile = this.pathFor(checkpointId);
    const stored: StoredCheckpoint = {
      version: 1,
      checkpointId,
      runId: this.options.runId,
      timestamp: new Date().toISOString(),
      snapshotFile,
      ...value,
    };
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    await writeFile(snapshotFile, `${JSON.stringify(stored)}\n`, "utf8");
    const { contentBase64: _contentBase64, ...record } = stored;
    this.records.push(record);
    return record;
  }

  private async load(checkpointId: string): Promise<StoredCheckpoint> {
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      throw new CoreMindError("invalid_checkpoint_id", `非法 checkpointId：${checkpointId}`);
    }
    try {
      const stored = JSON.parse(
        await readFile(this.pathFor(checkpointId), "utf8"),
      ) as StoredCheckpoint;
      if (stored.version !== 1 || stored.checkpointId !== checkpointId)
        throw new Error("记录格式非法");
      return stored;
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "checkpoint_corrupt",
        `检查点 ${checkpointId} 读取失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private pathFor(checkpointId: string): string {
    return path.join(this.options.rootDir, this.options.runId, `${checkpointId}.json`);
  }

  private async safeTargetPath(input: string): Promise<string> {
    const cwd = await canonicalize(this.options.cwd);
    const target = await canonicalize(path.resolve(this.options.cwd, input));
    const relative = path.relative(cwd, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CoreMindError("checkpoint_failed", `检查点目标超出工作区：${input}`);
    }
    return target;
  }
}

async function readOptionalFile(targetPath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 使用 RunResult 中的记录重新计算当前 diff。 */
export async function inspectCheckpoint(
  record: CheckpointRecord,
  cwd: string,
): Promise<CheckpointDiff> {
  return managerFromRecord(record, cwd).diff(record.checkpointId);
}

/** 使用 RunResult 中的记录显式恢复目标文件。 */
export async function restoreCheckpoint(record: CheckpointRecord, cwd: string): Promise<void> {
  return managerFromRecord(record, cwd).restore(record.checkpointId);
}

function managerFromRecord(record: CheckpointRecord, cwd: string): CheckpointManager {
  const snapshotFile = path.resolve(record.snapshotFile);
  const runDirectory = path.dirname(snapshotFile);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(record.runId) ||
    path.basename(runDirectory) !== record.runId ||
    path.basename(snapshotFile) !== `${record.checkpointId}.json`
  ) {
    throw new CoreMindError("checkpoint_corrupt", "检查点记录路径与标识不一致");
  }
  return new CheckpointManager({ cwd, rootDir: path.dirname(runDirectory), runId: record.runId });
}

function pathArgument(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>).path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function canonicalize(input: string): Promise<string> {
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return current;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(input);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}
