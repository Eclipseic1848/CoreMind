import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_FILES = [
  "README.md",
  "README.en.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "CONTRIBUTING.en.md",
  "SECURITY.md",
  "SECURITY.en.md",
  "CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.en.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml",
  ".github/ISSUE_TEMPLATE/feature_request.yml",
  "docs/index.md",
  "docs/en/index.md",
  "docs/release/README.zh-CN.md",
  "docs/release/README.en.md",
  "docs/providers/README.zh-CN.md",
  "docs/providers/README.en.md",
  "docs/providers/matrix.json",
];

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function normalizePythonVersion(version) {
  return version
    .replace(/^(\d+\.\d+\.\d+)a(\d+)$/, "$1-alpha.$2")
    .replace(/^(\d+\.\d+\.\d+)b(\d+)$/, "$1-beta.$2")
    .replace(/^(\d+\.\d+\.\d+)rc(\d+)$/, "$1-rc.$2");
}

export function evaluateReleaseMetadata({
  packages,
  pythonVersion,
  requiredFilesMissing,
  providerMatrixCurrent,
}) {
  const blockers = [];
  const versions = [...new Set(packages.map((item) => item.version))];
  if (versions.length !== 1) {
    blockers.push(`npm 公开包版本不一致：${versions.join("、")}`);
  }
  const releaseVersion = versions.length === 1 ? versions[0] : undefined;
  const normalizedPython = normalizePythonVersion(pythonVersion);
  if (releaseVersion && normalizedPython !== releaseVersion) {
    blockers.push(`Python 版本 ${pythonVersion} 与 npm 版本 ${releaseVersion} 不一致`);
  }

  for (const item of packages) {
    if (item.license !== "MIT") blockers.push(`${item.name} 缺少 MIT license 元数据`);
    if (!item.repository) blockers.push(`${item.name} 缺少 repository 元数据`);
    if (!item.homepage) blockers.push(`${item.name} 缺少 homepage 元数据`);
    if (!item.bugs) blockers.push(`${item.name} 缺少 bugs 元数据`);
    if (!item.readmeExists) blockers.push(`${item.name} 缺少发布包 README.md`);
  }
  if (requiredFilesMissing.length > 0) {
    blockers.push(`缺少发布/社区文件：${requiredFilesMissing.join("、")}`);
  }
  if (!providerMatrixCurrent) blockers.push("Provider 矩阵与认证台账不一致");

  return {
    ready: blockers.length === 0,
    releaseVersion,
    npmPackages: packages.length,
    pythonVersion,
    blockers,
  };
}

export async function inspectRepository(rootDirectory, { allowDirty = false } = {}) {
  const packageDirectories = await readdir(path.join(rootDirectory, "packages"), {
    withFileTypes: true,
  });
  const packages = [];
  for (const directory of packageDirectories) {
    if (!directory.isDirectory()) continue;
    const packagePath = path.join(rootDirectory, "packages", directory.name, "package.json");
    if (!existsSync(packagePath)) continue;
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    if (manifest.private === true) continue;
    packages.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license ?? "",
      repository: normalizeMetadataUrl(manifest.repository),
      homepage: manifest.homepage ?? "",
      bugs: normalizeMetadataUrl(manifest.bugs),
      readmeExists: existsSync(path.join(path.dirname(packagePath), "README.md")),
    });
  }

  const pyproject = await readFile(path.join(rootDirectory, "python", "pyproject.toml"), "utf8");
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  if (!pythonVersion) throw new Error("无法从 python/pyproject.toml 读取版本");

  const missing = REQUIRED_FILES.filter((file) => !existsSync(path.join(rootDirectory, file)));
  const ledger = JSON.parse(
    await readFile(path.join(rootDirectory, "docs", "providers", "certifications.json"), "utf8"),
  );
  const matrix = JSON.parse(
    await readFile(path.join(rootDirectory, "docs", "providers", "matrix.json"), "utf8"),
  );
  const report = evaluateReleaseMetadata({
    packages,
    pythonVersion,
    requiredFilesMissing: missing,
    providerMatrixCurrent: matrix.generatedAt === ledger.updatedAt && matrix.providers.length >= 38,
  });

  const warnings = [];
  if (allowDirty) {
    warnings.push("已允许脏工作区；正式发布前必须移除此选项");
  } else {
    const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: rootDirectory,
      encoding: "utf8",
    });
    if (git.status !== 0) report.blockers.push("无法读取 Git 工作区状态");
    else if (git.stdout.trim()) report.blockers.push("Git 工作区不干净");
  }
  report.ready = report.blockers.length === 0;
  return { ...report, warnings };
}

function normalizeMetadataUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.url ?? "";
  return "";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const allowDirty = process.argv.includes("--allow-dirty");
  const json = process.argv.includes("--json");
  const report = await inspectRepository(repositoryRoot, { allowDirty });
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(
      report.ready
        ? `发布元数据预检通过：${report.npmPackages} 个 npm 包与 Python ${report.pythonVersion}`
        : `发布元数据预检失败：\n- ${report.blockers.join("\n- ")}`,
    );
    for (const warning of report.warnings) console.warn(`警告：${warning}`);
  }
  if (!report.ready) process.exitCode = 1;
}
