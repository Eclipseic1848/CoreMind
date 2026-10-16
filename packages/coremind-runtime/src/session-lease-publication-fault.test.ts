// 独立测试文件，避免与 Session appendFile 故障 mock 相互影响。
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  remaining: 0,
  lockPath: "",
  published: undefined as { pid: number; kind: string } | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const filename = String(args[0]);
      const marker = ".write.lock.candidate-";
      const index = filename.indexOf(marker);
      if (fault.remaining > 0 && index !== -1) {
        fault.remaining--;
        fault.lockPath = filename.slice(0, index + ".write.lock".length);
        // 先读真实正式锁，证明故障发生在完整 owner 已经发布之后。
        fault.published = JSON.parse(await actual.readFile(fault.lockPath, "utf8"));
        throw Object.assign(new Error("注入候选清理失败"), { code: "EIO" });
      }
      return actual.rm(...args);
    },
  };
});

import { acquireSessionWriteLease } from "./session-write-lease.js";

it("owner 发布后候选清理失败会撤销自己的正式锁，不遗留活 PID 孤锁", async () => {
  const root = path.resolve(tmpdir());
  const dir = mkdtempSync(path.join(root, "coremind-session-publication-fault-"));
  try {
    fault.remaining = 1;
    await expect(acquireSessionWriteLease(dir, "cleanup-fault")).rejects.toMatchObject({
      code: "EIO",
    });
    expect(fault.remaining).toBe(0);
    expect(fault.published).toMatchObject({ pid: process.pid, kind: "write" });
    expect(fault.lockPath).not.toBe("");
    expect(existsSync(fault.lockPath)).toBe(false);
    const retry = await acquireSessionWriteLease(dir, "cleanup-fault");
    try {
      expect(existsSync(`${retry.sessionPath}.write.lock`)).toBe(true);
    } finally {
      await retry.release();
    }
    expect(existsSync(fault.lockPath)).toBe(false);
  } finally {
    fault.remaining = 0;
    expect(path.dirname(path.resolve(dir))).toBe(root);
    expect(path.basename(dir)).toMatch(/^coremind-session-publication-fault-/u);
    rmSync(dir, { recursive: true, force: true });
  }
});
