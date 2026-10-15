import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateReleaseIdentity } from "./release-artifacts.mjs";
import { normalizePythonVersion } from "./release-version.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commitPlaceholder = "{{RELEASE_COMMIT}}";

export function renderControlledReleaseNotes(
  template,
  { version, requestedTag, headSha, tagSha, dirty },
) {
  normalizePythonVersion(version);
  if (!/^[0-9a-f]{40}$/u.test(headSha) || !/^[0-9a-f]{40}$/u.test(tagSha)) {
    throw new Error("发布说明必须绑定完整的 HEAD 与标签提交 SHA");
  }
  if (typeof dirty !== "boolean") throw new Error("缺少真实工作区状态");
  const blockers = evaluateReleaseIdentity({ version, requestedTag, headSha, tagSha, dirty });
  if (blockers.length > 0) throw new Error(blockers.join("；"));
  if (typeof template !== "string" || !template.trim()) throw new Error("固定发布说明为空");
  const lines = template.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== `# CoreMind ${requestedTag}`) throw new Error("发布说明标题与目标版本不一致");
  for (const line of [
    `Version: ${version}`,
    `Tag: ${requestedTag}`,
    `Commit: ${commitPlaceholder}`,
  ]) {
    if (lines.filter((item) => item === line).length !== 1) {
      throw new Error("发布说明版本、标签或提交身份行缺失或重复");
    }
  }
  if (template.split(commitPlaceholder).length !== 2) {
    throw new Error("发布说明必须恰好包含一个提交占位符");
  }
  if (/\{\{|\}\}/u.test(template.replace(commitPlaceholder, ""))) {
    throw new Error("发布说明包含未知占位符");
  }
  for (const heading of ["## 简体中文", "## English"]) {
    const start = lines.indexOf(heading);
    if (start < 0 || lines.lastIndexOf(heading) !== start) {
      throw new Error("发布说明必须包含唯一的中英文章节");
    }
    const rest = lines.slice(start + 1);
    const next = rest.findIndex((line) => line.startsWith("## "));
    const body = next < 0 ? rest : rest.slice(0, next);
    if (!body.some((line) => line.trim() && !line.trim().startsWith("#"))) {
      throw new Error("发布说明中英文正文不得为空");
    }
  }
  return template.replace(commitPlaceholder, headSha);
}

export function assertExistingReleaseNotes(existing, expected) {
  if (typeof existing !== "string" || typeof expected !== "string" || !expected.trim()) {
    throw new Error("既有 Release 正文缺失或格式不正确");
  }
  // 只兼容换行编码和一个终止换行，不折叠正文内部空白。
  const normalize = (text) => text.replaceAll("\r\n", "\n").replace(/\n$/u, "");
  if (normalize(existing) !== normalize(expected)) {
    throw new Error("既有 Release 正文与受控说明冲突；拒绝覆盖");
  }
}

function git(args) {
  const result = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("无法读取发布说明的真实 Git 身份");
  return result.stdout.trim();
}

function parseArguments(args) {
  const accepted = new Set(["--tag", "--output", "--manifest", "--existing-release"]);
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!accepted.has(flag) || values.has(flag) || !value || value.startsWith("--")) {
      throw new Error("发布说明参数未知、重复或缺少值");
    }
    values.set(flag, value);
  }
  if (!values.has("--tag") || (!values.has("--output") && !values.has("--existing-release"))) {
    throw new Error("发布说明要求 --tag 及 --output 或 --existing-release");
  }
  if (values.has("--existing-release") && !values.has("--manifest")) {
    throw new Error("既有 Release 比较要求 --manifest");
  }
  return values;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("发布说明所需 JSON 文件缺失或格式不正确");
  }
}

async function main(args) {
  const options = parseArguments(args);
  const { version } = await readJson(path.join(repositoryRoot, "package.json"));
  normalizePythonVersion(version);
  const requestedTag = options.get("--tag");
  if (requestedTag !== `v${version}`) throw new Error("请求标签与当前根版本不一致");
  const headSha = git(["rev-parse", "--verify", "HEAD"]);
  const tagSha = git(["rev-parse", "--verify", `refs/tags/${requestedTag}^{commit}`]);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"]) !== "";
  const template = await readFile(
    path.join(repositoryRoot, "docs", "release", "notes", `v${version}.md`),
    "utf8",
  );
  const body = renderControlledReleaseNotes(template, {
    version,
    requestedTag,
    headSha,
    tagSha,
    dirty,
  });
  if (options.has("--manifest")) {
    const manifest = await readJson(options.get("--manifest"));
    if (
      manifest?.schemaVersion !== 1 ||
      manifest.version !== version ||
      manifest.tag !== requestedTag ||
      manifest.commit !== headSha ||
      (manifest.candidate !== undefined && manifest.candidate !== false)
    ) {
      throw new Error("发布清单与说明版本、标签、提交或正式发布身份不一致");
    }
  }
  if (options.has("--existing-release")) {
    const existing = await readJson(options.get("--existing-release"));
    assertExistingReleaseNotes(existing?.body, body);
    console.log("既有 Release 正文与受控说明一致");
    return;
  }
  const output = path.resolve(options.get("--output"));
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, body, { encoding: "utf8", flag: "wx" });
  console.log("受控发布说明已生成");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "受控发布说明校验失败");
    process.exitCode = 1;
  }
}
