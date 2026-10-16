import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  kind: undefined as "open" | "write" | undefined,
  hits: 0,
  filename: "",
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const filename = String(args[0]);
      if (fault.kind && filename.includes(`.${fault.kind}.lock.released-`)) {
        fault.kind = undefined;
        fault.hits++;
        fault.filename = filename;
        throw Object.assign(new Error("注入一次租约 tombstone 删除失败"), { code: "EIO" });
      }
      return actual.rm(...args);
    },
  };
});

import { CoreMindSession, sessionSnapshot } from "./session.js";

let directory: string;
let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(path.join(temporaryRoot, "coremind-session-release-fault-"));
  fault.hits = 0;
  fault.filename = "";
});
afterEach(async () => {
  fault.kind = undefined;
  expect(path.dirname(directory)).toBe(temporaryRoot);
  expect(path.basename(directory)).toMatch(/^coremind-session-release-fault-/u);
  await rm(directory, { recursive: true, force: true });
});

describe("会话已落盘但租约释放失败", () => {
  it.each(["open", "write"] as const)(
    "%s tombstone 删除失败后旧 holder 拒绝续写，新打开者可接续",
    async (kind) => {
      const options = { dir: directory, sessionId: "release-fault", cwd: directory };
      const session = await CoreMindSession.open(options);
      const initialSnapshot = sessionSnapshot(session);
      const prefix = await readFile(session.filePath, "utf8");
      // 仅对 append 后的释放故障注入，不拦 candidate、正式锁创建或初始 open。
      fault.kind = kind;
      await expect(
        session.appendMessages([{ role: "user", content: "已提交但释放失败", timestamp: 1 }]),
      ).rejects.toMatchObject(
        kind === "write"
          ? { code: "session_lock_recovery_required", cause: { code: "EIO" } }
          : { code: "EIO" },
      );
      expect(fault.hits).toBe(1);
      expect(fault.filename).toContain(`.${kind}.lock.released-`);
      expect(fault.filename).not.toContain(".candidate-");
      const committed = await readFile(session.filePath, "utf8");
      expect(committed.startsWith(prefix)).toBe(true);
      expect(committed).not.toBe(prefix);
      if (kind === "open") expect(sessionSnapshot(session)).toBe(initialSnapshot);

      await expect(
        session.appendMessages([{ role: "user", content: "旧 holder 不得写入", timestamp: 2 }]),
      ).rejects.toMatchObject({ code: "session_snapshot_stale" });
      expect(await readFile(session.filePath, "utf8")).toBe(committed);

      const reopened = await CoreMindSession.open(options);
      expect(
        (await reopened.buildContext()).messages.map((message) =>
          "content" in message ? message.content : undefined,
        ),
      ).toEqual(["已提交但释放失败"]);
      await reopened.appendMessages([{ role: "user", content: "重新打开后接续", timestamp: 3 }]);
      const fresh = await CoreMindSession.open(options);
      const entries = await fresh.branchEntries();
      expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
      expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0]!.id]);
      expect(
        (await fresh.buildContext()).messages.map((message) =>
          "content" in message ? message.content : undefined,
        ),
      ).toEqual(["已提交但释放失败", "重新打开后接续"]);
      expect(fault.hits).toBe(1);
    },
  );
});
