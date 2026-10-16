import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  afterRead: undefined as ((filename: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const value = await actual.readFile(...args);
      const hook = fault.afterRead;
      if (hook && String(args[0]).endsWith(".write.lock")) {
        fault.afterRead = undefined;
        await hook(String(args[0]));
      }
      return value;
    },
  };
});

import {
  acquireSessionWriteLease,
  assertSessionWriteLease,
  type SessionWriteLease,
  withSessionIO,
} from "./session-write-lease.js";

let directory: string;
let temporaryRoot: string;
const leases = new Set<SessionWriteLease>();
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(path.join(temporaryRoot, "coremind-session-writer-"));
});
afterEach(async () => {
  fault.afterRead = undefined;
  try {
    await Promise.all([...leases].map((lease) => lease.release()));
  } finally {
    leases.clear();
    expect(path.dirname(directory)).toBe(temporaryRoot);
    expect(path.basename(directory)).toMatch(/^coremind-session-writer-/u);
    await rm(directory, { recursive: true, force: true });
  }
});

async function identity(dir = directory): Promise<string> {
  const filename = path.join(await realpath(dir), "session.jsonl");
  return process.platform === "win32" ? filename.toLowerCase() : filename;
}
async function take(dir = directory): Promise<SessionWriteLease> {
  const lease = await acquireSessionWriteLease(dir, "session");
  leases.add(lease);
  return lease;
}
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
  const pid = child.pid;
  await once(child, "exit");
  expect(pid).toBeTypeOf("number");
  expect(() => process.kill(pid!, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
  return pid!;
}
async function owner(kind: "open" | "write", pid = process.pid) {
  return { schemaVersion: 1, kind, sessionPath: await identity(), pid, nonce: randomUUID() };
}

describe("会话跨进程所有权锁", () => {
  it("活的同 PID 写入者不可重入，正式 owner 完整且不可伪造", async () => {
    const lease = await take();
    const current = JSON.parse(await readFile(`${lease.sessionPath}.write.lock`, "utf8"));
    expect(current).toMatchObject({
      schemaVersion: 1,
      kind: "write",
      sessionPath: lease.sessionPath,
      pid: process.pid,
    });
    expect(current.nonce).toMatch(/^[0-9a-f-]{36}$/u);
    await assertSessionWriteLease(lease, lease.sessionPath);
    await expect(take()).rejects.toMatchObject({ code: "session_write_locked" });
    expect(JSON.parse(await readFile(`${lease.sessionPath}.write.lock`, "utf8"))).toEqual(current);
  });

  it("活的同 PID open owner 不会被回收，等待有界且不进入 I/O", async () => {
    const current = await owner("open");
    const lock = `${current.sessionPath}.open.lock`;
    await writeFile(lock, JSON.stringify(current), "utf8");
    const entered = vi.fn(async () => undefined);
    await expect(withSessionIO(directory, "session", entered)).rejects.toMatchObject({
      code: "session_open_locked",
    });
    expect(entered).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(current);
  });

  it("拒绝错误会话、伪造令牌和释放开始后立即失效的令牌", async () => {
    const lease = await take();
    await expect(
      assertSessionWriteLease(lease, `${lease.sessionPath}-wrong`),
    ).rejects.toMatchObject({ code: "session_write_lease_invalid" });
    const fake = { sessionPath: lease.sessionPath, release: async () => {} };
    await expect(assertSessionWriteLease(fake, lease.sessionPath)).rejects.toMatchObject({
      code: "session_write_lease_invalid",
    });
    const releasing = lease.release();
    await expect(assertSessionWriteLease(lease, lease.sessionPath)).rejects.toMatchObject({
      code: "session_write_lease_invalid",
    });
    await releasing;
    await lease.release();
    expect(await readdir(directory)).toEqual([]);
  });

  it("同一目录的不同拼法竞争，同名会话的不同真实目录可独立写", async () => {
    const first = await take();
    const other = path.join(directory, "other");
    await mkdir(other);
    await expect(take(`${other}${path.sep}..`)).rejects.toMatchObject({
      code: "session_write_locked",
    });
    const second = await take(other);
    expect(second.sessionPath).not.toBe(first.sessionPath);
    await assertSessionWriteLease(second, second.sessionPath);
  });

  it.skipIf(process.platform !== "win32")("Windows junction 不能绕过目录身份", async () => {
    const actual = path.join(directory, "actual");
    const alias = path.join(directory, "alias");
    await mkdir(actual);
    await symlink(actual, alias, "junction");
    try {
      const lease = await take(actual);
      await expect(take(alias)).rejects.toMatchObject({ code: "session_write_locked" });
      await assertSessionWriteLease(lease, lease.sessionPath);
    } finally {
      await unlink(alias);
    }
  });

  it.each(["", "{", "{}"])("旧空锁或损坏 open owner 必须失败关闭：%j", async (text) => {
    const lock = `${await identity()}.open.lock`;
    await writeFile(lock, text, "utf8");
    const entered = vi.fn(async () => undefined);
    await expect(withSessionIO(directory, "session", entered)).rejects.toMatchObject({
      code: "session_lock_recovery_required",
    });
    expect(entered).not.toHaveBeenCalled();
    expect(await readFile(lock, "utf8")).toBe(text);
  });

  it.each(["open", "write"] as const)("仅凭真实已退出 PID 安全回收 %s 锁", async (kind) => {
    const previous = await owner(kind, await deadPid());
    const lock = `${previous.sessionPath}.${kind}.lock`;
    await writeFile(lock, JSON.stringify(previous), "utf8");
    const inspect = async () => {
      const current = JSON.parse(await readFile(lock, "utf8"));
      expect(current).toMatchObject({ kind, sessionPath: previous.sessionPath, pid: process.pid });
      expect(current.nonce).not.toBe(previous.nonce);
    };
    if (kind === "write") {
      const lease = await take();
      await inspect();
      await lease.release();
    } else {
      await withSessionIO(directory, "session", inspect);
    }
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["open", "write"] as const)("残留 reclaim claim 不允许猜测回收 %s", async (kind) => {
    const previous = await owner(kind, await deadPid());
    const lock = `${previous.sessionPath}.${kind}.lock`;
    const claim = `${lock}.reclaim-${previous.nonce}`;
    await writeFile(lock, JSON.stringify(previous), "utf8");
    await writeFile(claim, "未确认所有权", "utf8");
    const attempt = kind === "write" ? take() : withSessionIO(directory, "session", async () => {});
    await expect(attempt).rejects.toMatchObject({ code: "session_lock_recovery_required" });
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(previous);
    expect(await readFile(claim, "utf8")).toBe("未确认所有权");
  });

  it("取得旧 owner 后发生替换，claim 内二次核验保留新的活 owner", async () => {
    const previous = await owner("write", await deadPid());
    const replacement = await owner("write");
    const lock = `${previous.sessionPath}.write.lock`;
    await writeFile(lock, JSON.stringify(previous), "utf8");
    fault.afterRead = async (filename) => {
      await writeFile(filename, JSON.stringify(replacement), "utf8");
    };
    await expect(take()).rejects.toMatchObject({ code: "session_lock_recovery_required" });
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(replacement);
    expect(await readdir(directory)).toEqual([path.basename(lock)]);
  });

  it("owner 被替换后旧令牌失效，旧 release 不能删除新锁", async () => {
    const lease = await take();
    const replacement = await owner("write");
    const lock = `${lease.sessionPath}.write.lock`;
    await writeFile(lock, JSON.stringify(replacement), "utf8");
    await expect(assertSessionWriteLease(lease, lease.sessionPath)).rejects.toMatchObject({
      code: "session_write_lease_invalid",
    });
    leases.delete(lease);
    await expect(lease.release()).rejects.toMatchObject({ code: "session_lock_recovery_required" });
    expect(JSON.parse(await readFile(lock, "utf8"))).toEqual(replacement);
  });
});
