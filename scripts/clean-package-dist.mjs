import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectory = path.resolve(process.cwd());
const target = path.join(packageDirectory, "dist");
const relative = path.relative(repositoryRoot, target);

// 只允许清理本仓库某个包的 dist，避免工作目录异常时扩大删除范围。
if (
  path.basename(target) !== "dist" ||
  relative === "dist" ||
  relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative)
) {
  throw new Error(`拒绝清理不安全的构建目录：${target}`);
}

await rm(target, { recursive: true, force: true });
