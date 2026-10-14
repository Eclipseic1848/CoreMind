import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionFileSystem } from "./file-system.js";

describe("会话文件系统窄适配", () => {
  it("UTF-8 读写、追加和替换保持，缺失与路径错误不混淆", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-fs-"));
    try {
      const fs = new SessionFileSystem({ cwd: dir });
      expect(await fs.writeFile("source.jsonl", "中文\n")).toEqual({ ok: true, value: undefined });
      expect(await fs.appendFile("source.jsonl", "尾部\n")).toEqual({ ok: true, value: undefined });
      expect(await fs.writeFile("target.jsonl", "旧内容")).toEqual({ ok: true, value: undefined });
      expect(await fs.renameFile("source.jsonl", "target.jsonl")).toEqual({
        ok: true,
        value: undefined,
      });
      expect(await fs.readTextFile("target.jsonl")).toEqual({ ok: true, value: "中文\n尾部\n" });
      expect(await fs.exists("source.jsonl")).toEqual({ ok: true, value: false });
      expect(await fs.readTextFile("missing.jsonl")).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
      expect(await fs.exists("bad\0path")).toMatchObject({
        ok: false,
        error: { code: "unknown" },
      });
      expect(await fs.fileInfo("target.jsonl")).toMatchObject({
        ok: true,
        value: { kind: "file", size: 14 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("已取消读取与原子替换不触碰原文件", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coremind-session-fs-abort-"));
    try {
      const fs = new SessionFileSystem({ cwd: dir });
      await fs.writeFile("original", "原值");
      await fs.writeFile("replacement", "新值");
      const signal = AbortSignal.abort();
      expect(await fs.readTextFile("original", signal)).toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      expect(await fs.renameFile("replacement", "original", signal)).toMatchObject({
        ok: false,
        error: { code: "aborted" },
      });
      expect(await fs.readTextFile("original")).toEqual({ ok: true, value: "原值" });
      expect(await fs.readTextFile("replacement")).toEqual({ ok: true, value: "新值" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
