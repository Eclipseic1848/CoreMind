import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function evaluateSourceArchiveEntries(entries) {
  const blockers = [];
  for (const entry of entries) {
    const normalized = String(entry).replaceAll("\\", "/").replace(/^\.\//, "");
    const relative = normalized.includes("/")
      ? normalized.slice(normalized.indexOf("/") + 1)
      : normalized;
    if (!relative || relative.endsWith("/")) continue;
    const lower = relative.toLowerCase();
    const basename = path.posix.basename(lower);
    const isGoldenCheckpointPlaceholder =
      /^examples\/golden\/[^/]+\/\.coremind\/checkpoints\/\.gitkeep$/i.test(relative);
    const forbidden =
      /(^|\/)(plan|handoff|claude)\.md$/i.test(relative) ||
      lower.startsWith("docs/analysis/") ||
      lower === "docs/coremind-iteration-plan-2026-08-31.md" ||
      /(^|\/)(node_modules|coverage|\.pytest_cache|__pycache__|\.scratch)(\/|$)/i.test(relative) ||
      (!isGoldenCheckpointPlaceholder &&
        /(^|\/)\.coremind\/(runs|checkpoints)(\/|$)/i.test(relative)) ||
      /(^|\/)sessions(\/|$)/i.test(relative) ||
      /(^|\/)(build|dist)(\/|$)/i.test(relative) ||
      /\.(pyc|tsbuildinfo|log)$/i.test(relative) ||
      basename === ".npmrc" ||
      basename === ".pypirc" ||
      (basename.startsWith(".env") && basename !== ".env.example");
    if (forbidden) blockers.push(relative);
  }
  return blockers;
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "coremind-source-artifact-"));
  try {
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
    const prefix = `coremind-${manifest.version}-source`;
    const archiveArgument = readArchiveArgument();
    const archive = archiveArgument ?? path.join(temporaryRoot, `${prefix}.zip`);
    if (archiveArgument) {
      if (!existsSync(archive)) throw new Error(`指定的源码 ZIP 不存在：${archive}`);
    } else {
      const temporaryIndex = path.join(temporaryRoot, "git-index");
      const gitEnvironment = {
        ...process.env,
        GIT_INDEX_FILE: temporaryIndex,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "false",
      };

      run("git", ["read-tree", "HEAD"], repositoryRoot, gitEnvironment);
      run("git", ["add", "-A", "--", "."], repositoryRoot, gitEnvironment, false, false);
      const tree = run(
        "git",
        ["write-tree"],
        repositoryRoot,
        gitEnvironment,
        false,
        false,
      ).stdout.trim();
      run(
        "git",
        ["archive", "--format=zip", `--prefix=${prefix}/`, `--output=${archive}`, tree],
        repositoryRoot,
        gitEnvironment,
      );
    }

    const entries = run("tar", ["-tf", archive], repositoryRoot, process.env, false, false)
      .stdout.split(/\r?\n/)
      .filter(Boolean);
    const blockers = evaluateSourceArchiveEntries(entries);
    if (blockers.length > 0) {
      throw new Error(`源码 ZIP 包含禁止文件：\n- ${blockers.join("\n- ")}`);
    }

    const extractionRoot = path.join(temporaryRoot, "extracted");
    await mkdir(extractionRoot);
    run("tar", ["-xf", archive, "-C", extractionRoot], repositoryRoot);
    const sourceRoot = path.join(extractionRoot, prefix);
    await rejectWorkstationPaths(sourceRoot);

    runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"], sourceRoot);
    runNpm(["run", "build"], sourceRoot);
    runNpm(["run", "check"], sourceRoot);
    run(
      process.execPath,
      [path.join(sourceRoot, "packages", "coremind-cli", "dist", "cli.js"), "--version"],
      sourceRoot,
    );
    console.log(`源码 ZIP 干净安装、构建与自检通过：${entries.length} 个条目`);
  } finally {
    const resolved = path.resolve(temporaryRoot);
    const systemTemp = path.resolve(os.tmpdir());
    if (
      resolved.startsWith(`${systemTemp}${path.sep}`) &&
      path.basename(resolved).startsWith("coremind-source-artifact-")
    ) {
      await rm(resolved, { recursive: true, force: true });
    }
  }
}

function readArchiveArgument() {
  const index = process.argv.indexOf("--archive");
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) throw new Error("--archive 需要 ZIP 路径");
  return path.resolve(value);
}

async function rejectWorkstationPaths(root) {
  const workstationPath =
    /(?:[A-Za-z]:[\\/](?:Users|home|new branch)[\\/]|\/(?:home|Users)\/[^/\s]+\/)/i;
  const extensions = new Set([
    ".md",
    ".mjs",
    ".js",
    ".ts",
    ".tsx",
    ".py",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".txt",
  ]);
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const content = await readFile(fullPath, "utf8");
      if (workstationPath.test(content)) {
        throw new Error(`${path.relative(root, fullPath)} 包含本机绝对路径`);
      }
    }
  }
}

function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd, process.env, true);
}

function run(command, args, cwd, environment = process.env, shell = false, echo = true) {
  const completed = spawnSync(command, args, {
    cwd,
    env: environment,
    shell,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (echo && completed.stdout) process.stdout.write(completed.stdout);
  if (echo && completed.stderr) process.stderr.write(completed.stderr);
  if (completed.status !== 0) {
    throw new Error(`命令失败（${completed.status}）：${command} ${args.join(" ")}`);
  }
  return completed;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
