import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { CoreMindSession } from "./session.js";

it.each([false, true])("物理目录别名双向重开与分叉不迁移既有存储，反向=%s", async (reverse) => {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-session-alias-"));
  const actual = path.join(root, "actual");
  const alias = path.join(root, "alias");
  mkdirSync(actual);
  symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const [first, next] = reverse ? [alias, actual] : [actual, alias];
    const dir = path.join(actual, ".coremind", "sessions");
    const session = await CoreMindSession.open({ dir, cwd: first, sessionId: "shared" });
    await session.appendMessages([{ role: "user", content: "保留历史", timestamp: 1 }]);
    const publicPath = path.join(dir, "shared.jsonl");
    const bytes = readFileSync(publicPath);
    const identity = statSync(publicPath);
    const directories = readdirSync(dir);
    const reopened = await CoreMindSession.open({
      dir: path.join(next, ".coremind", "sessions"),
      cwd: next,
      sessionId: "shared",
    });
    expect(reopened.isNew).toBe(false);
    const tree = await reopened.inspectTree();
    expect(tree.nodes).toHaveLength(1);
    const fork = await reopened.fork({ sessionId: "shared", entryId: tree.nodes[0]!.id });
    expect(fork.nodes).toEqual(tree.nodes);
    expect(readFileSync(publicPath)).toEqual(bytes);
    expect(statSync(publicPath).ino).toBe(identity.ino);
    expect(readdirSync(dir).filter((name) => name.startsWith("--"))).toEqual(
      directories.filter((name) => name.startsWith("--")),
    );
    expect(readdirSync(dir).some((name) => name.includes("backup"))).toBe(false);
  } finally {
    unlinkSync(alias);
    rmSync(root, { recursive: true, force: true });
  }
});

it("不同物理 cwd 与复制的同 id 公开文件均不能作为别名恢复", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-session-alias-reject-"));
  try {
    const other = path.join(root, "other");
    mkdirSync(other);
    const dir = path.join(root, "sessions");
    const session = await CoreMindSession.open({ dir, cwd: root, sessionId: "shared" });
    await session.appendMessages([{ role: "user", content: "私有历史", timestamp: 1 }]);
    const publicPath = path.join(dir, "shared.jsonl");
    const bytes = readFileSync(publicPath);
    await expect(
      CoreMindSession.open({ dir, cwd: other, sessionId: "shared" }),
    ).rejects.toMatchObject({
      code: "session_migration_invalid",
    });
    const alias = path.join(root, "alias");
    symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
    try {
      const copy = path.join(dir, "copy.jsonl");
      copyFileSync(publicPath, copy);
      unlinkSync(publicPath);
      copyFileSync(copy, publicPath);
      await expect(
        CoreMindSession.open({ dir, cwd: alias, sessionId: "shared" }),
      ).rejects.toMatchObject({
        code: "session_migration_invalid",
      });
      expect(readFileSync(publicPath)).toEqual(bytes);
    } finally {
      unlinkSync(alias);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
