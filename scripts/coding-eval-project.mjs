import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

export function prepareRepository(profile) {
  const id = profile === "typescript" ? "typescript-defect" : "python-defect";
  const projectDir = mkdtempSync(path.join(tmpdir(), `coremind-real-${id}-`));
  cpSync(path.join(repositoryRoot, "examples", "coding-evals", id), projectDir, {
    recursive: true,
  });
  git(projectDir, "init");
  git(projectDir, "config", "user.email", "coremind@example.invalid");
  git(projectDir, "config", "user.name", "CoreMind Eval");
  git(projectDir, "add", ".");
  git(projectDir, "commit", "-m", "defect baseline");
  writeFileSync(
    path.join(projectDir, "user-notes.txt"),
    "用户自己的未提交草稿，必须原样保留。\n",
    "utf8",
  );
  return projectDir;
}

export function removeTemporaryRepository(projectDir) {
  const resolved = path.resolve(projectDir);
  if (
    path.dirname(resolved) !== path.resolve(tmpdir()) ||
    !path.basename(resolved).startsWith("coremind-real-")
  ) {
    throw new Error(`拒绝清理非评测临时目录：${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function git(cwd, ...args) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}
