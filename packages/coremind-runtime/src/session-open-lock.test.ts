import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ remaining: 0, attempts: 0, code: "EPERM" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]).endsWith(".open.lock")) {
        fault.attempts++;
        if (fault.remaining-- > 0) {
          throw Object.assign(new Error("注入锁文件打开失败"), { code: fault.code });
        }
      }
      return actual.open(...args);
    },
  };
});

import { CoreMindSession } from "./session.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const directories: string[] = [];
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  fault.remaining = 0;
  fault.attempts = 0;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function options() {
  const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-lock-"));
  directories.push(dir);
  return { dir, cwd: dir, sessionId: "lock-test" };
}

describe("会话打开锁的 Windows 瞬时占用", () => {
  it.each(["EPERM", "EACCES"])("%s 消失后才进入会话创建", async (code) => {
    Object.defineProperty(process, "platform", { value: "win32" });
    fault.code = code;
    fault.remaining = 2;
    const opts = options();
    const session = await CoreMindSession.open(opts);
    expect(session.isNew).toBe(true);
    expect(fault.attempts).toBe(3);
    expect(existsSync(`${session.filePath}.open.lock`)).toBe(false);
  });

  it("持续权限错误有界退出，保留错误且不创建会话", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    fault.code = "EPERM";
    fault.remaining = Number.POSITIVE_INFINITY;
    const opts = options();
    await expect(CoreMindSession.open(opts)).rejects.toMatchObject({ code: "EPERM" });
    expect(fault.attempts).toBeGreaterThan(1);
    expect(existsSync(path.join(opts.dir, "lock-test.jsonl"))).toBe(false);
  });

  it("非 Windows 权限错误立即返回", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    fault.code = "EPERM";
    fault.remaining = 2;
    await expect(CoreMindSession.open(options())).rejects.toMatchObject({ code: "EPERM" });
    expect(fault.attempts).toBe(1);
  });
});
