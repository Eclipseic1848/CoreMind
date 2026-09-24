import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitDiffTool,
  createGitLogTool,
  createGitStatusTool,
  GitAdapter,
  GitAdapterError,
} from "./git-adapter.js";

describe("GitAdapter", () => {
  it("子目录工作区的默认查询和 magic pathspec 不泄露仓库外层文件", async () => {
    const cwd = createRepository();
    writeFileSync(path.join(cwd, "outside.txt"), "外层秘密\n", "utf8");
    git(cwd, "add", "outside.txt");
    git(cwd, "commit", "-m", "outside-only");
    writeFileSync(path.join(cwd, "outside.txt"), "外层修改\n", "utf8");
    writeFileSync(path.join(cwd, "src", "value.ts"), "内部修改\n", "utf8");
    const adapter = new GitAdapter({ cwd: path.join(cwd, "src") });
    expect(await adapter.status()).not.toContain("outside.txt");
    expect(await adapter.diff()).not.toContain("外层");
    expect(await adapter.diff({ path: ":(top)outside.txt" })).not.toContain("外层");
    expect(await adapter.log()).not.toContain("outside-only");
    expect(await adapter.diff()).toContain("内部修改");
  });

  it("只读查询不执行仓库 fsmonitor 配置", async () => {
    const cwd = createRepository();
    const marker = path.join(cwd, "fsmonitor-ran");
    git(cwd, "config", "core.fsmonitor", "echo unsafe > fsmonitor-ran");
    await new GitAdapter({ cwd }).status();
    expect(existsSync(marker)).toBe(false);
  });
  it("只读返回状态、统一 diff 和日志", async () => {
    const cwd = createRepository();
    writeFileSync(path.join(cwd, "src", "value.ts"), "export const value = 2;\n", "utf8");
    writeFileSync(path.join(cwd, "notes.txt"), "用户草稿\n", "utf8");
    const adapter = new GitAdapter({ cwd });

    await expect(adapter.status()).resolves.toContain("src/value.ts");
    await expect(adapter.diff({ path: "src/value.ts" })).resolves.toContain(
      "+export const value = 2;",
    );
    await expect(adapter.log({ limit: 1 })).resolves.toContain("initial");
    await expect(adapter.statusEntries()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/value.ts", index: " ", worktree: "M" }),
        expect.objectContaining({ path: "notes.txt", index: "?", worktree: "?" }),
      ]),
    );
  });

  it("拒绝工作区外路径，且不会把路径解释为 git 参数", async () => {
    const cwd = createRepository();
    const adapter = new GitAdapter({ cwd });

    await expect(adapter.diff({ path: "../outside.txt" })).rejects.toMatchObject({
      code: "git_path_outside_workspace",
    });
    await expect(adapter.diff({ path: "--output=outside.patch" })).resolves.not.toThrow;
  });

  it("非仓库和非法日志数量返回稳定错误", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "coremind-git-none-"));
    const adapter = new GitAdapter({ cwd });

    await expect(adapter.status()).rejects.toBeInstanceOf(GitAdapterError);
    await expect(adapter.log({ limit: 0 })).rejects.toMatchObject({ code: "git_invalid_request" });
  });

  it("三个内置工具使用固定名称并透传取消信号", async () => {
    const cwd = createRepository();
    writeFileSync(path.join(cwd, "src", "value.ts"), "export const value = 3;\n", "utf8");
    const tools = [createGitStatusTool(cwd), createGitDiffTool(cwd), createGitLogTool(cwd)];

    expect(tools.map((tool) => tool.name)).toEqual(["git_status", "git_diff", "git_log"]);
    const result = await tools[1]?.execute("call-diff", { path: "src/value.ts" }, undefined);
    expect(result?.content[0]).toMatchObject({ type: "text" });
  });
});

function createRepository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), "coremind-git-"));
  mkdirSync(path.join(cwd, "src"));
  writeFileSync(path.join(cwd, "src", "value.ts"), "export const value = 1;\n", "utf8");
  git(cwd, "init");
  git(cwd, "config", "user.email", "coremind@example.invalid");
  git(cwd, "config", "user.name", "CoreMind Test");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  return cwd;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}
