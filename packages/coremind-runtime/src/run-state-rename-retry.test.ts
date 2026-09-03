import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const renameFault = vi.hoisted(() => ({ failuresRemaining: 0, attempts: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (temporary: string, destination: string) => {
      renameFault.attempts += 1;
      if (renameFault.failuresRemaining > 0) {
        renameFault.failuresRemaining -= 1;
        throw Object.assign(new Error("injected transient rename failure"), { code: "EPERM" });
      }
      await actual.rename(temporary, destination);
    },
  };
});

import { FileRunStore, type RunStateRecord } from "./run-state.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  renameFault.failuresRemaining = 0;
  renameFault.attempts = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("FileRunStore Windows 原子发布重试", () => {
  it("首条记录连续七次 rename 返回 EPERM 时有界重试并只提交一次", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "coremind-run-state-rename-retry-"));
    temporaryDirectories.push(directory);
    const store = new FileRunStore(directory);
    const item: RunStateRecord = {
      version: 1,
      runId: "run-rename-retry",
      sequence: 1,
      timestamp: new Date().toISOString(),
      kind: "start",
      payload: { configFingerprint: "same" },
    };
    renameFault.failuresRemaining = 7;

    await expect(store.append(item)).resolves.toBeUndefined();
    expect(renameFault.attempts).toBe(8);
    await expect(store.read(item.runId)).resolves.toEqual([item]);
  });
});
