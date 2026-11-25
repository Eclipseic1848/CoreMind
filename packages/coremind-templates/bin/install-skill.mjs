#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { findSkill } from "coremind-templates";
import { readStandardSkillPackage } from "coremind-templates/internal";

const run = promisify(execFile);
const pinnedSource = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u;
const skillPath = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*SKILL\.md$/u;
const lockName = "skills-lock.json";

export function checkId(id) {
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) ||
    id.length > 64 ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/u.test(id) ||
    findSkill(id)
  ) {
    throw new Error(`Skill ID 无效或与内置 Skill 冲突：${id}`);
  }
}

function readPinnedLock(bytes, id) {
  const lock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const entries = Object.entries(lock?.skills ?? {});
  const [[name, entry] = []] = entries;
  if (
    lock?.version !== 2 ||
    entries.length !== 1 ||
    name !== id ||
    entry?.sourceType !== "github" ||
    typeof entry.source !== "string" ||
    typeof entry.commit !== "string" ||
    !pinnedSource.test(`${entry.source}@${entry.commit}`) ||
    entry.ref !== entry.commit ||
    typeof entry.computedHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(entry.computedHash) ||
    typeof entry.skillPath !== "string" ||
    !skillPath.test(entry.skillPath) ||
    entry.sourceUrl !== undefined ||
    entry.skillName !== undefined ||
    entry.installMode !== "copy"
  ) {
    throw new Error(`内容锁须只包含 ${id} 的公开 GitHub 完整提交与内容摘要`);
  }
  return entry;
}

async function readInstallFiles(sourceDir, id) {
  checkId(id);
  const { skill, source, manifest } = await readStandardSkillPackage(sourceDir, id);
  if (!manifest) throw new Error(`待安装的 Skill 缺少 coremind.skill.json：${id}`);
  return {
    version: skill.packageVersion,
    files: new Map([
      ["SKILL.md", source],
      ["coremind.skill.json", manifest],
      ...skill.resources.map(({ path, content }) => [path, content]),
    ]),
  };
}

function verifyGitTree(tree, sourcePath, files) {
  const folder = path.posix.dirname(sourcePath);
  const entries = new Map(
    tree
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return [line.slice(tab + 1), line.slice(0, tab)];
      }),
  );
  for (const [relative, content] of files) {
    const fullPath = path.posix.join(folder, relative);
    const hash = createHash("sha1")
      .update(`blob ${Buffer.byteLength(content, "utf8")}\0`, "utf8")
      .update(content, "utf8")
      .digest("hex");
    const entry = entries.get(fullPath);
    if (entry !== `100644 blob ${hash}` && entry !== `100755 blob ${hash}`) {
      throw new Error(`固定提交中的文件类型或原始字节不匹配：${fullPath}`);
    }
  }
}

async function localDirectory(directory) {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`必须是本地普通目录：${directory}`);
  }
  return realpath(directory);
}

async function replaceSkillPackage(configDir, id, files) {
  checkId(id);
  const root = path.join(await localDirectory(configDir), "skills");
  await mkdir(root, { recursive: true });
  await localDirectory(root);
  const target = path.join(root, id);
  const stage = path.join(root, `.${id}.install`);
  await mkdir(stage);
  const next = path.join(stage, "next");
  const previous = path.join(stage, "previous");
  let keepStage = false;
  try {
    for (const [relative, content] of files) {
      const file = path.join(next, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    }
    const current = await lstat(target).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    if (current && !current.isDirectory()) throw new Error(`Skill 目标须为普通目录：${target}`);
    if (current) await rename(target, previous);
    try {
      await rename(next, target);
    } catch (error) {
      if (current) {
        try {
          await rename(previous, target);
        } catch (rollbackError) {
          keepStage = true;
          throw new AggregateError([error, rollbackError], `回退失败，旧版保存在 ${previous}`);
        }
      }
      throw error;
    }
  } finally {
    if (!keepStage) await rm(stage, { recursive: true, force: true });
  }
}

export async function installSkill(configDir, id, packageJson, lockFile, source, runChild = run) {
  checkId(id);
  if (source !== undefined && !pinnedSource.test(source)) {
    throw new Error("技能源须使用 owner/repo@完整 Git 提交 SHA");
  }
  const cliPackage = JSON.parse(await readFile(packageJson, "utf8"));
  if (cliPackage.name !== "skills" || cliPackage.version !== "1.9.0") {
    throw new Error("安装需要 Skills CLI 1.9.0");
  }
  const cli = path.resolve(path.dirname(packageJson), "bin/cli.mjs");
  const config = await localDirectory(configDir);
  const lock = path.join(await realpath(path.dirname(lockFile)), path.basename(lockFile));
  const skillsRelative = path.relative(path.join(config, "skills"), lock);
  if (
    skillsRelative !== ".." &&
    !skillsRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(skillsRelative)
  ) {
    throw new Error("内容锁应放在项目 skills 目录之外");
  }

  const stage = await mkdtemp(path.join(tmpdir(), "coremind-skill-"));
  const env = {
    ...process.env,
    DISABLE_TELEMETRY: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    XDG_STATE_HOME: stage,
    GH_CONFIG_DIR: stage,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(stage, "gitconfig"),
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_DIR: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_TEMPLATE_DIR: undefined,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: undefined,
    GIT_ALLOW_PROTOCOL: "https",
    TEMP: stage,
    TMP: stage,
    TMPDIR: stage,
  };
  try {
    const frozen = path.join(stage, "frozen");
    await mkdir(frozen);
    const options = { cwd: frozen, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 };
    let bytes;
    if (source) {
      const seed = path.join(stage, "seed");
      await mkdir(seed);
      await runChild(
        process.execPath,
        [cli, "add", source, "--skill", id, "--agent", "codex", "--copy", "--yes"],
        {
          ...options,
          cwd: seed,
        },
      );
      bytes = await readFile(path.join(seed, lockName));
    } else {
      bytes = await readFile(lock);
    }
    const entry = readPinnedLock(bytes, id);
    if (source && source !== `${entry.source}@${entry.commit}`) {
      throw new Error("内容锁的技能源与请求不一致");
    }
    const frozenLock = path.join(frozen, lockName);
    await writeFile(frozenLock, bytes);
    await runChild(
      process.execPath,
      [cli, "install", "--frozen-lockfile", "--agent", "codex"],
      options,
    );
    if (!(await readFile(frozenLock)).equals(bytes)) throw new Error("冻结安装改写了内容锁");
    const { version, files } = await readInstallFiles(
      path.join(frozen, ".agents", "skills", id),
      id,
    );

    // 上游复制会展开符号链接，核对固定提交的树以保留源文件类型和原始字节约束。
    const bareRepo = path.join(stage, "source.git");
    await runChild("git", ["init", "--bare", "--quiet", bareRepo], options);
    const git = (args) => runChild("git", ["--git-dir", bareRepo, ...args], options);
    await git([
      "fetch",
      "--quiet",
      "--no-tags",
      "--depth=1",
      `https://github.com/${entry.source}.git`,
      entry.commit,
    ]);
    const folder = path.posix.dirname(entry.skillPath);
    const { stdout } = await git(["ls-tree", "-r", "-z", entry.commit, "--", folder]);
    verifyGitTree(stdout, entry.skillPath, files);

    if (source) await copyFile(frozenLock, lock, constants.COPYFILE_EXCL);
    await replaceSkillPackage(config, id, files);
    return {
      id,
      version,
      commit: entry.commit,
      lockSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function runSkillInstaller(args) {
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "用法：coremind-skill-install <配置目录> <Skill ID> <Skills CLI package.json> <锁文件> [owner/repo@完整提交]",
    );
    return;
  }
  if (args.length < 4 || args.length > 5) {
    process.stderr.write(
      "用法：coremind-skill-install <配置目录> <Skill ID> <Skills CLI package.json> <锁文件> [owner/repo@完整提交]\n",
    );
    process.exitCode = 1;
  } else {
    try {
      const { id, version, commit, lockSha256 } = await installSkill(...args);
      process.stdout.write(`已安装 ${id} ${version} @ ${commit}\n内容锁 SHA-256 ${lockSha256}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && pathToFileURL(await realpath(process.argv[1])).href === import.meta.url) {
  await runSkillInstaller(process.argv.slice(2));
}
