import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({ target: "", calls: 0, prefix: "", partial: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (String(args[0]) === fault.target && ++fault.calls === 2) {
        fault.prefix = await actual.readFile(fault.target, "utf8");
        // 使用真实第二条的字节，去掉最后右花括号和换行，制造未完成 JSON 尾。
        const text = String(args[1]);
        if (!text.endsWith("}\n")) throw new Error("预期收到完整 JSONL mutation");
        fault.partial = text.slice(0, -2);
        await actual.appendFile(args[0], fault.partial, "utf8");
        throw Object.assign(new Error("注入第二条追加失败"), { code: "EIO" });
      }
      return actual.appendFile(...args);
    },
  };
});

import { CoreMindSession } from "./session.js";
import { SessionFileSystem } from "./session-v4/file-system.js";
import { JsonlSessionRepo } from "./session-v4/index.js";

it("批量部分写入失败后旧 holder 失效，重新打开原位恢复且接续序号连续", async () => {
  const root = path.resolve(tmpdir());
  const dir = mkdtempSync(path.join(root, "coremind-session-write-fault-"));
  const opts = { dir, cwd: dir, sessionId: "partial-write" };
  try {
    const holder = await CoreMindSession.open(opts);
    const repo = new JsonlSessionRepo({
      fs: new SessionFileSystem({ cwd: dir }),
      sessionsRoot: dir,
    });
    const metadata = (await repo.list({ cwd: dir })).find((item) => item.id === opts.sessionId)!;
    expect(metadata.path).not.toBe(holder.filePath);
    const inode = statSync(holder.filePath).ino;
    expect(statSync(metadata.path).ino).toBe(inode);
    Object.assign(fault, { target: metadata.path, calls: 0, prefix: "", partial: "" });
    await expect(
      holder.appendMessages([
        { role: "user", content: "保留首条中文🙂", timestamp: 1 },
        { role: "user", content: "第二条发生坏尾", timestamp: 2 },
        { role: "user", content: "第三条不得执行", timestamp: 3 },
      ]),
    ).rejects.toThrow("注入第二条追加失败");
    expect(fault.calls).toBe(2);
    expect(fault.prefix.trimEnd().split("\n")).toHaveLength(2);
    const broken = `${fault.prefix}${fault.partial}`;
    expect(readFileSync(holder.filePath, "utf8")).toBe(broken);
    await expect(
      holder.appendMessages([{ role: "user", content: "旧 holder 不得接续", timestamp: 4 }]),
    ).rejects.toMatchObject({ code: "session_snapshot_stale" });
    expect(fault.calls).toBe(2);
    expect(readFileSync(metadata.path, "utf8")).toBe(broken);
    const reopened = await CoreMindSession.open(opts);
    expect(readFileSync(reopened.filePath, "utf8")).toBe(fault.prefix);
    expect(readFileSync(metadata.path, "utf8")).toBe(fault.prefix);
    expect(statSync(reopened.filePath).ino).toBe(inode);
    expect(statSync(metadata.path).ino).toBe(inode);
    expect(
      (await reopened.buildContext()).messages.map((item) =>
        "content" in item ? item.content : undefined,
      ),
    ).toEqual(["保留首条中文🙂"]);
    expect((await reopened.branchEntries()).map((item) => item.seq)).toEqual([1]);
    await reopened.appendMessages([{ role: "user", content: "恢复后继续", timestamp: 5 }]);
    const continued = await CoreMindSession.open(opts);
    expect((await continued.branchEntries()).map((item) => item.seq)).toEqual([1, 2]);
    expect(
      (await continued.buildContext()).messages.map((item) =>
        "content" in item ? item.content : undefined,
      ),
    ).toEqual(["保留首条中文🙂", "恢复后继续"]);
    expect(fault.calls).toBe(3);
  } finally {
    fault.target = "";
    expect(path.dirname(path.resolve(dir))).toBe(root);
    expect(path.basename(dir)).toMatch(/^coremind-session-write-fault-/u);
    rmSync(dir, { recursive: true, force: true });
  }
});
