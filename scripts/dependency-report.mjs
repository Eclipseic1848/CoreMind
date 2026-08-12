import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
];

export async function buildDependencyReport(rootDirectory, generatedAt = localDate()) {
  const root = path.resolve(rootDirectory);
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const manifests = await Promise.all(
    ["packages/coremind-runtime/package.json", "packages/coremind-tools/package.json"].map(
      async (relativePath) => JSON.parse(await readFile(path.join(root, relativePath), "utf8")),
    ),
  );
  const dependencies = [];
  const allVersions = new Set();
  for (const name of TARGETS) {
    const suffix = `node_modules/${name}`;
    const installed = Object.entries(lock.packages ?? {}).filter(
      ([packagePath, metadata]) => packagePath.endsWith(suffix) && metadata?.version,
    );
    const versions = [...new Set(installed.map(([, metadata]) => metadata.version))].sort();
    for (const version of versions) allVersions.add(version);
    const primary =
      installed.find(([packagePath]) => packagePath === suffix)?.[1] ?? installed[0]?.[1];
    const declarations = manifests
      .map((manifest) => manifest.dependencies?.[name])
      .filter((version) => typeof version === "string");
    dependencies.push({
      name,
      declaredVersions: [...new Set(declarations)].sort(),
      installedVersions: versions,
      resolved: primary?.resolved ?? "",
      integrity: primary?.integrity ?? "",
    });
  }
  const versions = [...allVersions].sort();
  return {
    schemaVersion: 1,
    generatedAt,
    summary: {
      lockstep: versions.length === 1,
      version: versions.length === 1 ? versions[0] : null,
      packages: dependencies.length,
    },
    dependencies,
    packaging: {
      cliShrinkwrap: false,
      reason: "CLI 与 SDK 共用工作区 Lockfile、干净安装和 tarball 内容门禁",
    },
    audit: {
      command: "npm run security:audit",
      registryDifferences: "进入发布候选前在 Windows/Linux 干净环境分别复核",
    },
  };
}

async function runCli() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputPath = path.join(root, "baselines", "0.3.0-candidate", "dependency-report.json");
  const report = await buildDependencyReport(root);
  if (process.argv.includes("--check")) {
    if (!existsSync(outputPath)) throw new Error(`依赖报告不存在：${outputPath}`);
    const expected = JSON.parse(await readFile(outputPath, "utf8"));
    const comparableExpected = { ...expected, generatedAt: report.generatedAt };
    if (JSON.stringify(comparableExpected) !== JSON.stringify(report)) {
      throw new Error("核心依赖报告与 Lockfile 不一致，请先运行 npm run dependencies:report");
    }
    if (!report.summary.lockstep) throw new Error("核心依赖未锁步");
    console.log(
      `核心依赖报告检查通过：${report.summary.packages} 个包 @ ${report.summary.version}`,
    );
    return;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`核心依赖报告已生成：${outputPath}`);
}

function localDate() {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value, index) => (index === 0 ? String(value) : String(value).padStart(2, "0")))
    .join("-");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
