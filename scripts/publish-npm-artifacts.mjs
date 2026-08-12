import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_ORDER = [
  "coremind-config",
  "coremind-protocol",
  "coremind-tools",
  "coremind-templates",
  "coremind-runtime",
  "coremind-ai",
  "coremind-worker",
  "coremind-cli",
];

export function createNpmPublishPlan(manifest) {
  const artifacts = (manifest.artifacts ?? []).filter((item) => item.kind === "npm");
  const byName = new Map();
  for (const item of artifacts) {
    if (byName.has(item.name)) throw new Error(`npm 发布物重复：${item.name}`);
    if (item.version !== manifest.version) {
      throw new Error(`${item.name} 版本 ${item.version} 与发布版本 ${manifest.version} 不一致`);
    }
    byName.set(item.name, item);
  }
  const missing = PUBLISH_ORDER.filter((name) => !byName.has(name));
  if (missing.length > 0) throw new Error(`缺少 npm 发布物：${missing.join("、")}`);
  if (artifacts.length !== PUBLISH_ORDER.length) {
    const unexpected = artifacts.filter((item) => !PUBLISH_ORDER.includes(item.name));
    throw new Error(`存在意外 npm 发布物：${unexpected.map((item) => item.name).join("、")}`);
  }
  if (!["latest", "next"].includes(manifest.npmDistTag)) {
    throw new Error(`不支持的 npm dist-tag：${manifest.npmDistTag}`);
  }
  return PUBLISH_ORDER.map((name) => ({
    ...byName.get(name),
    distTag: manifest.npmDistTag,
  }));
}

export function npmTarballIntegrity(content) {
  return `sha512-${createHash("sha512").update(content).digest("base64")}`;
}

export function decideExistingNpmArtifact(localIntegrity, registryIntegrity) {
  if (!registryIntegrity) return "publish";
  if (registryIntegrity === localIntegrity) return "skip-identical";
  return "conflict";
}

async function publishArtifacts(rootDirectory) {
  const manifestPath = path.join(rootDirectory, "release-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const plan = createNpmPublishPlan(manifest);
  const transactionPath = path.join(rootDirectory, "publish-state.json");
  const transaction = {
    schemaVersion: 1,
    version: manifest.version,
    commit: manifest.commit,
    updatedAt: new Date().toISOString(),
    npm: {},
  };
  for (const item of plan) {
    const tarball = path.resolve(rootDirectory, item.path);
    if (!tarball.startsWith(`${path.resolve(rootDirectory)}${path.sep}`) || !existsSync(tarball)) {
      throw new Error(`${item.name} 发布物不存在或越界：${item.path}`);
    }
    const specifier = `${item.name}@${manifest.version}`;
    const localIntegrity = npmTarballIntegrity(await readFile(tarball));
    const existing = runNpm(["view", specifier, "dist.integrity", "--json"], true);
    if (existing.status === 0) {
      const registryIntegrity = parseRegistryIntegrity(existing.stdout);
      const decision = decideExistingNpmArtifact(localIntegrity, registryIntegrity);
      if (decision === "skip-identical") {
        transaction.npm[item.name] = { status: "verified-existing", integrity: localIntegrity };
        await persistTransaction(transactionPath, transaction);
        console.log(`npm 已存在且完整性一致，安全跳过：${specifier}`);
        continue;
      }
      throw new Error(
        `npm 已存在 ${specifier}，但完整性与本地发布物不一致；拒绝覆盖（registry=${registryIntegrity || "missing"}，local=${localIntegrity}）`,
      );
    }
    const diagnostic = `${existing.stdout}\n${existing.stderr}`;
    if (!/E404|404 Not Found|is not in this registry/i.test(diagnostic)) {
      throw new Error(`无法确认 ${specifier} 是否已发布：${diagnostic.trim()}`);
    }
    runNpm(["publish", tarball, "--access", "public", "--tag", item.distTag]);
    transaction.npm[item.name] = { status: "published", integrity: localIntegrity };
    await persistTransaction(transactionPath, transaction);
    console.log(`npm 发布完成：${specifier}（${item.distTag}）`);
  }
}

function parseRegistryIntegrity(stdout) {
  try {
    const value = JSON.parse(stdout);
    return typeof value === "string" ? value : "";
  } catch {
    return stdout.trim().replace(/^"|"$/g, "");
  }
}

async function persistTransaction(file, transaction) {
  transaction.updatedAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
}

function runNpm(args, allowFailure = false) {
  const npmCli = process.env.npm_execpath;
  const completed = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8" })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
  if (!allowFailure && completed.status !== 0) {
    throw new Error(`npm ${args[0]} 失败：${completed.stderr || completed.stdout}`);
  }
  return completed;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--publish")) {
    throw new Error("发布操作必须显式传入 --publish");
  }
  const directoryArgument = process.argv.find(
    (argument, index) => index > 1 && argument !== "--publish",
  );
  const rootDirectory = path.resolve(
    directoryArgument ?? path.join(repositoryRoot, "release-artifacts"),
  );
  await publishArtifacts(rootDirectory);
}
