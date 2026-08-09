import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPM_VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?$/;

export function normalizePythonVersion(version) {
  const match = NPM_VERSION.exec(version);
  if (!match) {
    throw new Error(`版本 ${version} 不符合 SemVer，或使用了不支持的预发布标识`);
  }
  const base = `${match[1]}.${match[2]}.${match[3]}`;
  if (!match[4]) return base;
  const label = match[4] === "alpha" ? "a" : match[4] === "beta" ? "b" : "rc";
  return `${base}${label}${match[5]}`;
}

export async function synchronizeReleaseVersion(rootDirectory, npmVersion) {
  const pythonVersion = normalizePythonVersion(npmVersion);
  const rootManifestPath = path.join(rootDirectory, "package.json");
  const rootManifest = await readJson(rootManifestPath);
  rootManifest.version = npmVersion;
  await writeJson(rootManifestPath, rootManifest);

  const packages = await readPublicPackages(rootDirectory);
  const internalNames = new Set(packages.map((item) => item.manifest.name));
  for (const item of packages) {
    item.manifest.version = npmVersion;
    synchronizeDependencies(item.manifest, internalNames, npmVersion);
    await writeJson(item.path, item.manifest);
  }

  const pyprojectPath = path.join(rootDirectory, "python", "pyproject.toml");
  const pyproject = await readFile(pyprojectPath, "utf8");
  if (!/^version\s*=\s*"[^"]+"/m.test(pyproject)) {
    throw new Error("python/pyproject.toml 缺少 project.version");
  }
  await writeFile(
    pyprojectPath,
    pyproject.replace(/^version\s*=\s*"[^"]+"/m, `version = "${pythonVersion}"`),
    "utf8",
  );

  const pythonInitPath = path.join(rootDirectory, "python", "src", "coremind", "__init__.py");
  const pythonInit = await readFile(pythonInitPath, "utf8");
  if (!/^__version__\s*=\s*"[^"]+"/m.test(pythonInit)) {
    throw new Error("python/src/coremind/__init__.py 缺少 __version__");
  }
  await writeFile(
    pythonInitPath,
    pythonInit.replace(/^__version__\s*=\s*"[^"]+"/m, `__version__ = "${pythonVersion}"`),
    "utf8",
  );

  return { npmVersion, pythonVersion, npmPackages: packages.length };
}

export async function validateReleaseVersion(rootDirectory) {
  const blockers = [];
  const rootManifest = await readJson(path.join(rootDirectory, "package.json"));
  const npmVersion = rootManifest.version;
  let expectedPython;
  try {
    expectedPython = normalizePythonVersion(npmVersion);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  const packages = await readPublicPackages(rootDirectory);
  const internalNames = new Set(packages.map((item) => item.manifest.name));
  for (const item of packages) {
    if (item.manifest.version !== npmVersion) {
      blockers.push(
        `${item.directory} 版本 ${item.manifest.version} 与根版本 ${npmVersion} 不一致`,
      );
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      const dependencies = item.manifest[field];
      if (!dependencies || typeof dependencies !== "object") continue;
      for (const [name, version] of Object.entries(dependencies)) {
        if (internalNames.has(name) && version !== npmVersion) {
          blockers.push(`${item.directory} 的内部依赖 ${name}=${version}，应为 ${npmVersion}`);
        }
      }
    }
  }

  const pyproject = await readFile(path.join(rootDirectory, "python", "pyproject.toml"), "utf8");
  const pythonInit = await readFile(
    path.join(rootDirectory, "python", "src", "coremind", "__init__.py"),
    "utf8",
  );
  const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  const runtimePythonVersion = /^__version__\s*=\s*"([^"]+)"/m.exec(pythonInit)?.[1];
  if (!pythonVersion) blockers.push("python/pyproject.toml 缺少 project.version");
  if (!runtimePythonVersion) blockers.push("Python SDK 缺少 __version__");
  if (expectedPython && pythonVersion !== expectedPython) {
    blockers.push(`Python 包版本 ${pythonVersion} 与 npm 版本 ${npmVersion} 不一致`);
  }
  if (pythonVersion && runtimePythonVersion !== pythonVersion) {
    blockers.push(`Python 运行时版本 ${runtimePythonVersion} 与包版本 ${pythonVersion} 不一致`);
  }

  return {
    ready: blockers.length === 0,
    npmVersion,
    pythonVersion,
    npmPackages: packages.length,
    blockers,
  };
}

async function readPublicPackages(rootDirectory) {
  const packageRoot = path.join(rootDirectory, "packages");
  const directories = await readdir(packageRoot, { withFileTypes: true });
  const packages = [];
  for (const directory of directories) {
    if (!directory.isDirectory()) continue;
    const manifestPath = path.join(packageRoot, directory.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = await readJson(manifestPath);
    if (manifest.private === true) continue;
    packages.push({ directory: directory.name, path: manifestPath, manifest });
  }
  return packages.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name));
}

function synchronizeDependencies(manifest, internalNames, version) {
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[field];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const name of Object.keys(dependencies)) {
      if (internalNames.has(name)) dependencies[name] = version;
    }
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function refreshPackageLock(rootDirectory) {
  const args = ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"];
  const npmCli = process.env.npm_execpath;
  const completed = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: rootDirectory, encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd: rootDirectory,
        encoding: "utf8",
        shell: process.platform === "win32",
      });
  if (completed.status !== 0) {
    throw new Error(`更新 package-lock.json 失败：${completed.stderr || completed.stdout}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const version = process.argv.find((argument) => /^\d+\.\d+\.\d+/.test(argument));
  if (!version) {
    throw new Error("用法：node scripts/release-version.mjs <semver> [--no-lock]");
  }
  const report = await synchronizeReleaseVersion(repositoryRoot, version);
  if (!process.argv.includes("--no-lock")) refreshPackageLock(repositoryRoot);
  const validation = await validateReleaseVersion(repositoryRoot);
  if (!validation.ready) throw new Error(`版本同步失败：\n- ${validation.blockers.join("\n- ")}`);
  console.log(
    `版本已同步：npm ${report.npmVersion}（${report.npmPackages} 个包），Python ${report.pythonVersion}`,
  );
}
