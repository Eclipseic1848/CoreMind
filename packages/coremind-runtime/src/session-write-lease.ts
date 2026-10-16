import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { CoreMindError } from "./errors.js";

type LockKind = "open" | "write";

interface SessionOwner {
  schemaVersion: 1;
  kind: LockKind;
  sessionPath: string;
  pid: number;
  nonce: string;
}

type OwnerInspection = { state: "missing" | "invalid" } | { state: "valid"; owner: SessionOwner };

export interface SessionWriteLease {
  readonly sessionPath: string;
  release(): Promise<void>;
}

interface IssuedLease {
  owner: SessionOwner;
  active: boolean;
}

const issued = new WeakMap<SessionWriteLease, IssuedLease>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** 锁身份不依赖可被替换的会话文件 inode。 */
async function canonicalSessionPath(directory: string, sessionId: string): Promise<string> {
  assertSessionId(sessionId);
  await mkdir(directory, { recursive: true });
  const canonical = path.normalize(await realpath(path.resolve(directory)));
  const root = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const filename = `${sessionId}.jsonl`;
  return path.join(root, process.platform === "win32" ? filename.toLowerCase() : filename);
}

/** 仅授予该会话的单写者身份；不等待同进程持有者，也不按时间猜测失活。 */
export async function acquireSessionWriteLease(
  directory: string,
  sessionId: string,
): Promise<SessionWriteLease> {
  const sessionPath = await canonicalSessionPath(directory, sessionId);
  return acquireOwned(sessionPath, "write");
}

/** 只有短 I/O 互斥会等待；与长期写租约分别证明所有权和死主状态。 */
export async function withSessionIO<T>(
  directory: string,
  sessionId: string,
  action: (sessionPath: string) => Promise<T>,
): Promise<T> {
  const sessionPath = await canonicalSessionPath(directory, sessionId);
  const lease = await acquireOwned(sessionPath, "open");
  let result: T;
  try {
    result = await action(sessionPath);
  } catch (error) {
    try {
      await lease.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "会话 I/O 与解锁均失败");
    }
    throw error;
  }
  await lease.release();
  return result;
}

async function acquireOwned(sessionPath: string, kind: LockKind): Promise<SessionWriteLease> {
  const owner: SessionOwner = {
    schemaVersion: 1,
    kind,
    sessionPath,
    pid: process.pid,
    nonce: randomUUID(),
  };
  const lockPath = `${sessionPath}.${kind}.lock`;
  const deadline = Date.now() + 2_000;
  for (let attempt = 0; ; attempt++) {
    try {
      await publishOwner(lockPath, owner);
      return issueLease(lockPath, owner);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const windowsContention = isWindowsPermissionError(error);
      if (code !== "EEXIST" && !windowsContention) throw error;
      let inspected: OwnerInspection;
      try {
        inspected = await inspectOwner(lockPath, sessionPath, kind);
      } catch (inspectionError) {
        if (kind !== "open" || !isWindowsPermissionError(inspectionError)) throw inspectionError;
        await waitForOpen(deadline, inspectionError);
        continue;
      }
      if (inspected.state === "invalid") throw recoveryRequired();
      if (inspected.state === "valid") {
        if (isProcessAlive(inspected.owner.pid)) {
          if (kind === "write") throw locked();
          await waitForOpen(deadline, error);
          continue;
        }
        if (!(await reclaimDeadOwner(lockPath, inspected.owner))) throw recoveryRequired();
      } else if (windowsContention && kind === "write") {
        throw error;
      }
      // 长租约不等待；安全回收或释放竞争后仅再争一次。
      if (kind === "write") {
        if (attempt >= 1) throw locked();
      } else {
        await waitForOpen(deadline, error);
      }
    }
  }
}

/** 在短 I/O 锁内核验后再写；该准入不替代在飞写入收敛。 */
export async function assertSessionWriteLease(
  lease: SessionWriteLease,
  expectedSessionPath: string,
): Promise<void> {
  const state = issued.get(lease);
  if (
    !state?.active ||
    state.owner.kind !== "write" ||
    state.owner.sessionPath !== expectedSessionPath
  )
    throw invalid();
  const current = await inspectOwner(
    `${expectedSessionPath}.write.lock`,
    expectedSessionPath,
    "write",
  );
  if (!state.active || current.state !== "valid" || !sameOwner(current.owner, state.owner)) {
    throw invalid();
  }
}

function issueLease(lockPath: string, owner: SessionOwner): SessionWriteLease {
  const state: IssuedLease = { owner, active: true };
  let closing: Promise<void> | undefined;
  const lease: SessionWriteLease = Object.freeze({
    sessionPath: owner.sessionPath,
    release: () => {
      if (!closing) {
        state.active = false;
        closing = removeOwnedLock(lockPath, owner);
      }
      return closing;
    },
  });
  issued.set(lease, state);
  return lease;
}

async function publishOwner(lockPath: string, owner: SessionOwner): Promise<void> {
  const candidatePath = `${lockPath}.candidate-${owner.nonce}`;
  const handle = await open(candidatePath, "wx");
  let published = false;
  let failure: unknown;
  try {
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.close();
    await link(candidatePath, lockPath);
    published = true;
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure = combineFailure(failure, error);
  }
  try {
    await rm(candidatePath, { force: true });
  } catch (error) {
    failure = combineFailure(failure, error);
  }
  // 获取失败不能留下一个当前进程仍存活、调用方却没有句柄的正式锁。
  if (published && failure !== undefined) {
    try {
      await removeOwnedLock(lockPath, owner);
    } catch (error) {
      failure = combineFailure(failure, error);
    }
  }
  if (failure !== undefined) throw failure;
}

async function removeOwnedLock(lockPath: string, owner: SessionOwner): Promise<void> {
  const current = await inspectOwner(lockPath, owner.sessionPath, owner.kind);
  if (current.state !== "valid" || !sameOwner(current.owner, owner)) throw recoveryRequired();
  const tombstone = `${lockPath}.released-${owner.nonce}`;
  await rename(lockPath, tombstone);
  await rm(tombstone);
}

async function reclaimDeadOwner(lockPath: string, owner: SessionOwner): Promise<boolean> {
  if (isProcessAlive(owner.pid)) return false;
  const claimPath = `${lockPath}.reclaim-${owner.nonce}`;
  const tombstone = `${claimPath}.tombstone-${randomUUID()}`;
  let claim: Awaited<ReturnType<typeof open>>;
  try {
    claim = await open(claimPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  let reclaimed = false;
  let failure: unknown;
  try {
    await claim.writeFile(JSON.stringify({ pid: process.pid, ownerNonce: owner.nonce }), "utf8");
    const current = await inspectOwner(lockPath, owner.sessionPath, owner.kind);
    if (
      current.state === "valid" &&
      sameOwner(current.owner, owner) &&
      !isProcessAlive(owner.pid)
    ) {
      await rename(lockPath, tombstone);
      reclaimed = true;
    }
  } catch (error) {
    failure = error;
  }
  try {
    await claim.close();
  } catch (error) {
    failure = combineFailure(failure, error);
  }
  for (const ownedPath of [tombstone, claimPath]) {
    try {
      await rm(ownedPath, { force: true });
    } catch (error) {
      failure = combineFailure(failure, error);
    }
  }
  if (failure !== undefined) throw failure;
  return reclaimed;
}

async function inspectOwner(
  lockPath: string,
  sessionPath: string,
  kind: LockKind,
): Promise<OwnerInspection> {
  try {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as Partial<SessionOwner> | null;
    if (
      owner?.schemaVersion !== 1 ||
      owner.kind !== kind ||
      owner.sessionPath !== sessionPath ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      typeof owner.nonce !== "string" ||
      !UUID.test(owner.nonce)
    ) {
      return { state: "invalid" };
    }
    return { state: "valid", owner: owner as SessionOwner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    if (error instanceof SyntaxError) return { state: "invalid" };
    throw error;
  }
}

function sameOwner(left: SessionOwner, right: SessionOwner): boolean {
  return (
    left.kind === right.kind &&
    left.sessionPath === right.sessionPath &&
    left.pid === right.pid &&
    left.nonce === right.nonce
  );
}

function isWindowsPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES");
}

async function waitForOpen(deadline: number, error: unknown): Promise<void> {
  if (Date.now() >= deadline) {
    if (isWindowsPermissionError(error)) throw error;
    throw new CoreMindError("session_open_locked", "该会话正由另一进程打开或写入");
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function assertSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !/^[a-zA-Z0-9_-]+$/u.test(sessionId)) {
    throw new CoreMindError("invalid_session_id", "会话 id 只能包含字母、数字、连字符与下划线");
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function combineFailure(previous: unknown, next: unknown): unknown {
  return previous === undefined
    ? next
    : new AggregateError([previous, next], "会话租约操作与清理均失败");
}

function locked(): CoreMindError {
  return new CoreMindError("session_write_locked", "该会话已有活动写入者，请等待原运行结束后重试");
}

function invalid(): CoreMindError {
  return new CoreMindError("session_write_lease_invalid", "会话写租约身份已变化或不再有效");
}

function recoveryRequired(): CoreMindError {
  return new CoreMindError(
    "session_lock_recovery_required",
    "会话锁损坏或恢复未完成，需先核验所有权",
  );
}
