import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createUnifiedDiff,
  DiffLimitError,
  type ResolvedToolCapability,
  resolveToolCapability,
} from "coremind-tools";
import { resolveFileToolTarget } from "coremind-tools/internal";
import { CoreMindError } from "./errors.js";
import { collectDeclaredStringFields } from "./tool-effect-selectors.js";
import { WorkspaceLeaseService } from "./workspace-lease.js";

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

export interface CheckpointFileState {
  existed: boolean;
  sha256?: string;
}

export interface CheckpointManagerOptions {
  cwd: string;
  rootDir: string;
  runId: string;
  maxFileBytes?: number;
}

interface CheckpointCorrelation {
  operationId?: string;
  toolCallId?: string;
  idempotencyKey?: string;
  capability?: ResolvedToolCapability;
}

interface CheckpointTargetSnapshot {
  targetPath: string;
  existed: boolean;
  beforeSha256?: string;
  contentBase64?: string;
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
    correlation: CheckpointCorrelation = {},
  ): Promise<CheckpointRecord | undefined> {
    return (await this.captureAll(tool, args, { ...correlation, pathFields: ["path"] }))[0];
  }

  /** Protocol 显式创建检查点；身份由调用方稳定提供。 */
  async capturePath(target: string, identity: { checkpointId: string }): Promise<CheckpointRecord> {
    const snapshot = await this.snapshotTarget(target);
    return this.persist({
      checkpointId: identity.checkpointId,
      tool: "checkpoint.create",
      reversible: true,
      ...snapshot,
    });
  }

  async captureAll(
    tool: string,
    args: unknown,
    correlation: CheckpointCorrelation & { pathFields?: readonly string[] } = {},
  ): Promise<CheckpointRecord[]> {
    const capability = correlation.capability ?? resolveToolCapability({ tool });
    const metadata = checkpointMetadata(correlation);
    if (capability.checkpoint === "none") return [];
    if (capability.checkpoint === "unsupported") {
      return [
        await this.persist({
          tool,
          ...metadata,
          reversible: false,
          reason: "任意命令或自定义工具可能产生工作区外副作用，无法保证自动回退",
        }),
      ];
    }

    const fileTarget = await resolveFileToolTarget(tool, args, this.options.cwd);
    const targets =
      fileTarget === undefined
        ? unique(collectDeclaredStringFields(args, correlation.pathFields ?? ["path"]))
        : [fileTarget];
    if (targets.length === 0) {
      throw new CoreMindError("checkpoint_failed", `工具 ${tool} 缺少可识别的 path 参数`);
    }
    const snapshots: CheckpointTargetSnapshot[] = [];
    for (const target of targets) snapshots.push(await this.snapshotTarget(target));
    const checkpoints: CheckpointRecord[] = [];
    for (const snapshot of snapshots) {
      checkpoints.push(await this.persist({ tool, ...metadata, reversible: true, ...snapshot }));
    }
    return checkpoints;
  }

  private async snapshotTarget(target: string): Promise<CheckpointTargetSnapshot> {
    const targetPath = await this.canonicalTargetPath(target);
    let content: Buffer | undefined;
    try {
      content = await readBoundedFile(targetPath, this.maxFileBytes);
    } catch (error) {
      if (error instanceof CoreMindError) throw error;
      throw new CoreMindError(
        "checkpoint_failed",
        `读取修改前文件失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      targetPath,
      existed: content !== undefined,
      ...(content
        ? { beforeSha256: sha256(content), contentBase64: content.toString("base64") }
        : {}),
    };
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
    const targetPath = await this.canonicalTargetPath(stored.targetPath);
    const before =
      stored.contentBase64 !== undefined ? Buffer.from(stored.contentBase64, "base64") : undefined;
    const after = await readBoundedFile(targetPath, this.maxFileBytes - (before?.byteLength ?? 0));
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
    const targetPath = await this.canonicalTargetPath(stored.targetPath);
    const after = await fileFingerprint(targetPath);
    if (stored.afterExisted === undefined) {
      // 写前快照已被日志引用；写后状态独立发布，日志提交失败时仍能校验原事实。
      await publishCheckpointFile(`${stored.snapshotFile}.applied`, {
        before: createHash("sha256").update(checkpointIdentity(stored), "utf8").digest("hex"),
        ...after,
      });
    } else if (stored.afterExisted !== after.existed || stored.afterSha256 !== after.sha256) {
      throw new CoreMindError("checkpoint_conflict", "检查点已固定其他写后状态");
    }

    const record = this.records.find((item) => item.checkpointId === checkpointId);
    if (record) {
      record.afterExisted = after.existed;
      if (after.sha256) record.afterSha256 = after.sha256;
      else delete record.afterSha256;
    }
  }

  /** 仅在调用方显式请求时恢复单个目标文件。 */
  async restore(checkpointId: string, expectedCurrent?: CheckpointFileState): Promise<void> {
    const lease = await new WorkspaceLeaseService().acquire({
      workspaceRoot: this.options.cwd,
      lane: "workspace_exclusive",
      owner: { runId: this.options.runId, callId: `restore:${checkpointId}` },
    });
    try {
      await this.restoreUnderLease(checkpointId, expectedCurrent);
    } finally {
      await lease.release({ activeTools: 0, activeProcesses: 0, pendingCriticalFacts: 0 });
    }
  }

  private async restoreUnderLease(
    checkpointId: string,
    expectedCurrent?: CheckpointFileState,
  ): Promise<void> {
    const stored = await this.load(checkpointId);
    if (!stored.reversible || !stored.targetPath) {
      throw new CoreMindError(
        "checkpoint_not_reversible",
        stored.reason ?? `检查点 ${checkpointId} 不可自动恢复`,
      );
    }
    const targetPath = await this.canonicalTargetPath(stored.targetPath);
    if (stored.afterExisted === undefined && expectedCurrent === undefined) {
      throw new CoreMindError(
        "checkpoint_conflict",
        `检查点 ${checkpointId} 缺少工具执行后的文件状态，无法安全恢复`,
      );
    }
    const { existed: currentExists, sha256: currentSha256 } = await fileFingerprint(targetPath);
    if (
      expectedCurrent !== undefined &&
      (currentExists !== expectedCurrent.existed ||
        (currentExists && currentSha256 !== expectedCurrent.sha256))
    ) {
      throw new CoreMindError(
        "checkpoint_conflict",
        `文件 ${stored.targetPath} 与恢复请求的预期当前状态不一致，已拒绝覆盖`,
      );
    }
    if (
      stored.afterExisted !== undefined &&
      (currentExists !== stored.afterExisted ||
        (currentExists && currentSha256 !== stored.afterSha256))
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
    > & { checkpointId?: string },
  ): Promise<CheckpointRecord> {
    const { checkpointId = randomUUID(), ...payload } = value;
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      throw new CoreMindError("invalid_checkpoint_id", `非法 checkpointId：${checkpointId}`);
    }
    const snapshotFile = this.pathFor(checkpointId);
    const stored: StoredCheckpoint = {
      version: 1,
      checkpointId,
      runId: this.options.runId,
      timestamp: new Date().toISOString(),
      snapshotFile,
      ...payload,
    };
    await mkdir(path.dirname(snapshotFile), { recursive: true });
    try {
      await publishCheckpointFile(snapshotFile, stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new CoreMindError(
          "checkpoint_conflict",
          `检查点 ${checkpointId} 已存在但缺少可验证的幂等 Fact`,
        );
      }
      throw error;
    }
    const { contentBase64: _contentBase64, ...record } = stored;
    this.records.push(record);
    return record;
  }

  private async load(checkpointId: string, includeApplied = true): Promise<StoredCheckpoint> {
    if (!/^[a-zA-Z0-9_-]+$/.test(checkpointId)) {
      throw new CoreMindError("invalid_checkpoint_id", `非法 checkpointId：${checkpointId}`);
    }
    try {
      const stored = JSON.parse(
        await readFile(this.pathFor(checkpointId), "utf8"),
      ) as StoredCheckpoint;
      if (
        stored.version !== 1 ||
        stored.checkpointId !== checkpointId ||
        stored.runId !== this.options.runId ||
        path.resolve(stored.snapshotFile) !== path.resolve(this.pathFor(checkpointId))
      )
        throw new Error("记录格式非法");
      if (stored.targetPath) await this.canonicalTargetPath(stored.targetPath);
      const before =
        stored.contentBase64 !== undefined
          ? Buffer.from(stored.contentBase64, "base64")
          : undefined;
      if (
        (stored.existed === true) !== (before !== undefined) ||
        (before !== undefined && sha256(before) !== stored.beforeSha256) ||
        (stored.existed === false && stored.beforeSha256 !== undefined)
      ) {
        throw new Error("快照内容与写前身份不一致");
      }
      if (includeApplied && stored.afterExisted === undefined) {
        let marker: string;
        try {
          marker = await readFile(`${stored.snapshotFile}.applied`, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return stored;
          throw error;
        }
        const applied = JSON.parse(marker);
        if (
          applied.before !==
            createHash("sha256").update(checkpointIdentity(stored), "utf8").digest("hex") ||
          typeof applied.existed !== "boolean" ||
          (applied.existed
            ? typeof applied.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(applied.sha256)
            : applied.sha256 !== undefined)
        )
          throw new Error("写后状态身份无效");
        stored.afterExisted = applied.existed;
        if (applied.existed) stored.afterSha256 = applied.sha256;
      }
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

  async verifyRecord(record: CheckpointRecord): Promise<void> {
    const stored = await this.load(record.checkpointId, record.afterExisted !== undefined);
    const { contentBase64: _contentBase64, ...publicStored } = stored;
    if (checkpointIdentity(publicStored) !== checkpointIdentity(record)) {
      throw new CoreMindError("checkpoint_corrupt", "检查点 Fact 与快照身份不一致");
    }
  }

  async canonicalTargetPath(input: string): Promise<string> {
    const cwd = await canonicalize(this.options.cwd);
    const target = await canonicalize(path.resolve(this.options.cwd, input));
    const relative = path.relative(cwd, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new CoreMindError("checkpoint_failed", `检查点目标超出工作区：${input}`);
    }
    return target;
  }
}

async function openOptionalFile(targetPath: string) {
  try {
    return await open(targetPath, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readBoundedFile(targetPath: string, limit: number): Promise<Buffer | undefined> {
  const tooLarge = () =>
    new CoreMindError("checkpoint_too_large", `检查点输入超过剩余 ${limit} 字节上限`);
  if (limit < 0) throw tooLarge();
  const file = await openOptionalFile(targetPath);
  if (!file) return undefined;
  try {
    if ((await file.stat()).size > limit) throw tooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - size + 1));
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > limit) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await file.close();
  }
}

async function fileFingerprint(targetPath: string): Promise<CheckpointFileState> {
  const file = await openOptionalFile(targetPath);
  if (!file) return { existed: false };
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { existed: true, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

async function publishCheckpointFile(destination: string, value: unknown): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    await link(temporary, destination);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** 使用 RunResult 中的记录重新计算当前 diff。 */
export async function inspectCheckpoint(
  record: CheckpointRecord,
  cwd: string,
): Promise<CheckpointDiff> {
  const manager = managerFromRecord(record, cwd);
  await manager.verifyRecord(record);
  return manager.diff(record.checkpointId);
}

/** 使用 RunResult 中的记录显式恢复目标文件。 */
export async function restoreCheckpoint(
  record: CheckpointRecord,
  cwd: string,
  expectedCurrent?: CheckpointFileState,
): Promise<void> {
  const manager = managerFromRecord(record, cwd);
  await manager.verifyRecord(record);
  if (record.reversible && record.afterExisted === undefined && expectedCurrent === undefined) {
    throw new CoreMindError(
      "checkpoint_conflict",
      "已提交的检查点缺少写后状态，恢复前须核实当前文件",
    );
  }
  return manager.restore(record.checkpointId, expectedCurrent);
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

function checkpointMetadata(
  correlation: CheckpointCorrelation,
): Omit<CheckpointCorrelation, "capability"> {
  return {
    ...(correlation.operationId ? { operationId: correlation.operationId } : {}),
    ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
    ...(correlation.idempotencyKey ? { idempotencyKey: correlation.idempotencyKey } : {}),
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function checkpointIdentity(record: CheckpointRecord): string {
  return JSON.stringify({
    version: record.version,
    checkpointId: record.checkpointId,
    runId: record.runId,
    operationId: record.operationId,
    toolCallId: record.toolCallId,
    idempotencyKey: record.idempotencyKey,
    timestamp: record.timestamp,
    tool: record.tool,
    reversible: record.reversible,
    targetPath: record.targetPath,
    existed: record.existed,
    beforeSha256: record.beforeSha256,
    afterExisted: record.afterExisted,
    afterSha256: record.afterSha256,
    reason: record.reason,
    snapshotFile: record.snapshotFile,
  });
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
