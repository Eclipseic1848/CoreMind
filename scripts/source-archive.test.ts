import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  containsWorkstationPath,
  decodeSourceArchive,
  evaluateSourceArchiveEntries,
  extractSourceArchive,
} from "./validate-source-archive.mjs";

describe("源码 ZIP 内容门禁", () => {
  it("拒绝真实 Windows、Unix 和 file URL 本机路径", () => {
    // 运行时拼接反例，避免源码自身包含待拒绝的本机路径。
    for (const value of [
      ["C:", "Users", "runner", "bundle.mjs"].join("\\"),
      ["c:", "users", "runner", "bundle.mjs"].join("/"),
      ["F:", "new branch", "example", "bundle.mjs"].join("/"),
      ["", "home", "runner", "bundle.mjs"].join("/"),
      `file://${["", "Users", "runner", "bundle.mjs"].join("/")}`,
    ]) {
      expect(containsWorkstationPath(value), value).toBe(true);
    }
  });

  it("允许现有 API 用户路由", () => {
    for (const value of [
      `/projects/\${project_id}/users/\${userID}/roles`,
      `/organization/users/\${userID}/roles`,
      "/api/Users/account/roles",
    ]) {
      expect(containsWorkstationPath(value), value).toBe(false);
    }
  });

  it("允许公开源码、测试和环境变量示例", () => {
    const result = evaluateSourceArchiveEntries([
      "coremind-source/package.json",
      "coremind-source/packages/coremind-cli/src/cli.ts",
      "coremind-source/packages/coremind-cli/src/cli.e2e.test.ts",
      "coremind-source/.env.example",
      "coremind-source/examples/golden/demo/.coremind/checkpoints/.gitkeep",
    ]);

    expect(result).toEqual([]);
  });

  it("拒绝内部计划、凭据、运行状态、依赖与生成缓存", () => {
    const result = evaluateSourceArchiveEntries([
      "coremind-source/handoff.md",
      "coremind-source/docs/analysis/private.md",
      "coremind-source/.env",
      "coremind-source/.npmrc",
      "coremind-source/node_modules/pkg/index.js",
      "coremind-source/.coremind/runs/run.jsonl",
      "coremind-source/python/.pytest_cache/CACHEDIR.TAG",
      "coremind-source/coverage/coverage-summary.json",
    ]);

    expect(result.join("\n")).toContain("handoff.md");
    expect(result.join("\n")).toContain("docs/analysis");
    expect(result.join("\n")).toContain(".env");
    expect(result.join("\n")).toContain("node_modules");
    expect(result.join("\n")).toContain(".coremind/runs");
    expect(result.join("\n")).toContain(".pytest_cache");
  });

  it("使用跨平台 ZIP 解码器读取源码包，不依赖系统 tar 对 ZIP 的兼容性", () => {
    const archive = zipSync({
      "coremind-source/": new Uint8Array(),
      "coremind-source/package.json": strToU8('{"name":"coremind"}'),
    });

    expect(Object.keys(decodeSourceArchive(archive))).toEqual([
      "coremind-source/",
      "coremind-source/package.json",
    ]);
  });

  it("解压前拒绝路径穿越条目", async () => {
    await expect(
      extractSourceArchive({ "../escape.txt": strToU8("blocked") }, "unused-source-root"),
    ).rejects.toThrow("源码 ZIP 包含非法路径");
  });
});
