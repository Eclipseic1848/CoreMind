import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_PATHS = [
  /(^|\/)[^/]*\.(test|spec)(\.[^/]+)+$/i,
  /(^|\/)(__tests__|tests?|fixtures?)(\/|$)/i,
  /(^|\/)(docs\/analysis|\.coremind|checkpoints?|runs?)(\/|$)/i,
  /(^|\/)(\.scratch|tmp|temp)(\/|$)/i,
  /(^|\/)(PLAN|handoff|CLAUDE)\.md$/i,
  /(^|\/)\.env(?:$|\.(?!example$)[^/]+$)/i,
  /(^|\/)(\.npmrc|\.pypirc|npm-debug\.log)$/i,
  /\.tsbuildinfo$/i,
];
const SESSION_DATA_PATH = /(^|\/)sessions?(\/|$)/i;
// 仅豁免现有会话实现的编译产物，真实会话数据继续拒绝。
const RUNTIME_SESSION_MODULE =
  /^dist\/session-v4\/session\/(context|jsonl|memory|session|state|types|jsonl\/(codec|errors|repo|storage|types)|testing\/(conformance|types))\.(js|d\.ts)(\.map)?$/;

export function evaluatePackageFiles({ packageName, declaredFiles, packedFiles, requiredFiles }) {
  const blockers = [];
  const normalizedDeclared = declaredFiles.map(normalizePackagePath);
  const normalizedPacked = packedFiles.map(normalizePackagePath);

  for (const file of normalizedPacked) {
    const runtimeSessionModule =
      packageName === "coremind-runtime" && RUNTIME_SESSION_MODULE.test(file);
    if (
      FORBIDDEN_PATHS.some((pattern) => pattern.test(file)) ||
      (SESSION_DATA_PATH.test(file) && !runtimeSessionModule)
    ) {
      blockers.push(`${packageName} 包含禁止发布的文件：${file}`);
      continue;
    }
    if (!isAllowlisted(file, normalizedDeclared)) {
      blockers.push(`${packageName} 文件不在 package.json files allowlist：${file}`);
    }
  }

  for (const required of requiredFiles.map(normalizePackagePath)) {
    if (!normalizedPacked.includes(required)) {
      blockers.push(`${packageName} 缺少入口：${required}`);
    }
  }

  return { ready: blockers.length === 0, blockers };
}

export async function inspectNpmPackages(rootDirectory = repositoryRoot) {
  const packageDirectories = await readdir(path.join(rootDirectory, "packages"), {
    withFileTypes: true,
  });
  const reports = [];
  for (const directory of packageDirectories) {
    if (!directory.isDirectory()) continue;
    const packagePath = path.join(rootDirectory, "packages", directory.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (manifest.private === true) continue;
    const packed = runNpmPackDryRun(rootDirectory, manifest.name);
    reports.push({
      packageName: manifest.name,
      ...evaluatePackageFiles({
        packageName: manifest.name,
        declaredFiles: Array.isArray(manifest.files) ? manifest.files : [],
        packedFiles: packed.files.map((file) => file.path),
        requiredFiles: collectRequiredEntries(manifest),
      }),
      entryCount: packed.entryCount,
      size: packed.size,
    });
  }
  return {
    ready: reports.every((report) => report.ready),
    packages: reports,
    blockers: reports.flatMap((report) => report.blockers),
  };
}

function runNpmPackDryRun(rootDirectory, packageName) {
  const npmCli = process.env.npm_execpath;
  const baseArgs = ["pack", "--workspace", packageName, "--json", "--dry-run"];
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...baseArgs], {
        cwd: rootDirectory,
        encoding: "utf8",
      })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", baseArgs, {
        cwd: rootDirectory,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
  if (result.status !== 0) {
    throw new Error(`npm pack ${packageName} 失败：${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout);
  const packed = payload[0];
  if (!packed || !Array.isArray(packed.files)) {
    throw new Error(`npm pack ${packageName} 未返回可检查的文件清单`);
  }
  return packed;
}

export function collectRequiredEntries(manifest) {
  const entries = new Set();
  if (manifest.name === "coremind-tools") {
    for (const filename of [
      "service.mjs",
      "guard.dll",
      "host.exe",
      "manifest.json",
      "metafile.json",
      "THIRD-PARTY-LICENSES.txt",
    ]) {
      entries.add(`dist/vendor/windows-mcp/${filename}`);
    }
  }
  collectEntry(manifest.main, entries);
  collectEntry(manifest.types, entries);
  collectEntry(manifest.bin, entries);
  collectEntry(manifest.exports, entries);
  return [...entries];
}

function collectEntry(value, entries) {
  if (typeof value === "string") {
    if (!value.includes("*")) entries.add(normalizePackagePath(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEntry(item, entries);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectEntry(item, entries);
  }
}

function isAllowlisted(file, declaredFiles) {
  if (
    /^(package\.json|README(?:\.[^/]+)?|LICENSE(?:\.[^/]+)?|CHANGELOG(?:\.[^/]+)?|NOTICE(?:\.[^/]+)?)$/i.test(
      file,
    )
  ) {
    return true;
  }
  return declaredFiles.some((entry) => file === entry || file.startsWith(`${entry}/`));
}

function normalizePackagePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const report = await inspectNpmPackages(repositoryRoot);
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else if (report.ready) {
    console.log(`npm 发布包内容检查通过：${report.packages.length} 个包`);
    for (const item of report.packages) {
      console.log(`- ${item.packageName}: ${item.entryCount} 个文件，${item.size} bytes`);
    }
  } else {
    console.error(`npm 发布包内容检查失败：\n- ${report.blockers.join("\n- ")}`);
  }
  if (!report.ready) process.exitCode = 1;
}
