import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";

export const REFERENCE_BASELINE_ID = "0.2.0-rc.1";
export const CANDIDATE_BASELINE_ID = "0.3.0-candidate";
const PACKAGE_DIRECTORY = "packages";
const PUBLIC_API_DIRECTORY = "public-api";
const ignoredContractPaths = new Set(["baseline.developmentCommit", "evidence"]);
const dependencyPackages = {
  "coding-layer": "@earendil-works/pi-coding-agent",
  "model-layer": "@earendil-works/pi-ai",
  "runtime-core": "@earendil-works/pi-agent-core",
};

export function evaluatePhase2Baseline(expected, actual) {
  const blockers = [];
  compareValue(expected, actual, "", blockers);
  return { ready: blockers.length === 0, blockers };
}

export async function capturePhase2Baseline(repositoryRoot, evidenceOptions = {}) {
  const root = path.resolve(repositoryRoot);
  const baselineId = evidenceOptions.baselineId ?? resolveActiveBaselineId(root);
  const { hashes: apiReports } = await collectPublicApiSnapshots(root);
  return assemblePhase2Baseline(root, evidenceOptions, apiReports, baselineId);
}

async function assemblePhase2Baseline(root, evidenceOptions, apiReports, baselineId) {
  const packageLockPath = path.join(root, "package-lock.json");
  const packageLock = await readJson(packageLockPath);
  const coverage = await readJson(path.join(root, "scripts", "coverage-baseline.json"));
  const baselineDirectory = path.join(root, "baselines", REFERENCE_BASELINE_ID);
  const behaviorMatrixPath = path.join(baselineDirectory, "behavior-matrix.json");
  const platformAcceptancePath = path.join(baselineDirectory, "platform-acceptance.json");
  const codingBenchmark = await readJson(path.join(baselineDirectory, "coding-benchmark.json"));
  const releaseGates = await readJson(path.join(baselineDirectory, "release-gates.json"));
  const behaviorMatrix = await readJson(behaviorMatrixPath);
  const platformAcceptance = await readJson(platformAcceptancePath);
  const { CoreMindConfigSchema } = await importBuiltPackage(
    root,
    "coremind-config",
    evidenceOptions.capturedAt,
  );
  const { ProtocolRequestSchema } = await importBuiltPackage(
    root,
    "coremind-protocol",
    evidenceOptions.capturedAt,
  );
  const { RC_CASES } = await import(
    `${pathToFileURL(path.join(root, "scripts", "rc-acceptance.mjs")).href}?baseline=${encodeURIComponent(
      evidenceOptions.capturedAt ?? Date.now(),
    )}`
  );
  const publicPackages = await discoverPublicPackages(root);
  const releaseManifestPath = path.join(
    root,
    "baselines",
    REFERENCE_BASELINE_ID,
    "release-manifest.json",
  );
  const referenceBaselinePath = path.join(baselineDirectory, "baseline.json");
  const referencePublicApiDirectory = path.join(baselineDirectory, PUBLIC_API_DIRECTORY);

  return {
    schemaVersion: 1,
    baseline: {
      version: baselineId,
      ...(baselineId === REFERENCE_BASELINE_ID ? {} : { referenceVersion: REFERENCE_BASELINE_ID }),
      developmentCommit: git(root, ["rev-parse", "HEAD"]),
      releaseCommit: git(root, ["rev-list", "-n", "1", `v${REFERENCE_BASELINE_ID}`]),
    },
    ...(baselineId === REFERENCE_BASELINE_ID
      ? {}
      : {
          referenceArtifacts: {
            baselineSha256: await hashFile(referenceBaselinePath),
            publicApiSha256: await hashDirectory(referencePublicApiDirectory),
            releaseManifestSha256: await hashFile(releaseManifestPath),
          },
        }),
    publicContracts: {
      apiReports,
      schemas: {
        config: hashCanonicalValue(CoreMindConfigSchema),
        protocol: hashCanonicalValue(ProtocolRequestSchema),
      },
    },
    dependencies: {
      installed: collectDependencyVersions(packageLock),
    },
    acceptance: {
      caseIds: RC_CASES.map((item) => item.id).sort(),
      entries: [...new Set(RC_CASES.flatMap((item) => item.entries))].sort(),
      behaviorCaseIds: behaviorMatrix.cases.map((item) => item.id).sort(),
      platforms: Object.keys(platformAcceptance.platforms).sort(),
      behaviorMatrixSha256: await hashFile(behaviorMatrixPath),
      platformAcceptanceSha256: await hashFile(platformAcceptancePath),
    },
    releaseArtifacts: {
      manifestSha256: await hashFile(releaseManifestPath),
    },
    quality: {
      coverage: {
        totals: coverage.totals,
        platforms: coverage.platforms,
        critical: coverage.critical,
        targets: coverage.targets,
      },
      codingEvalProfiles: await discoverCodingEvalProfiles(root),
      codingBenchmark,
      releaseGates: {
        nonRegression: releaseGates.nonRegression,
        hardSafety: releaseGates.hardSafety,
        alpha: releaseGates.alpha,
        beta: releaseGates.beta,
        rc: releaseGates.rc,
        longTermCoverageTargets: releaseGates.longTermCoverageTargets,
      },
    },
    evidence: {
      capturedAt: evidenceOptions.capturedAt ?? new Date().toISOString(),
      capturePlatform: evidenceOptions.capturePlatform ?? process.platform,
      updateReason: evidenceOptions.updateReason ?? null,
      apiExtractorVersion: Extractor.version,
      dependencyLockSha256: await hashFile(packageLockPath),
      codingEvalFixtureSha256: await hashDirectory(path.join(root, "examples", "coding-evals")),
      packageDistSha256: Object.fromEntries(
        await Promise.all(
          publicPackages.map(async ({ directory, name }) => [
            name,
            await hashDirectory(path.join(root, PACKAGE_DIRECTORY, directory, "dist")),
          ]),
        ),
      ),
      releaseManifestSha256: existsSync(releaseManifestPath)
        ? await hashFile(releaseManifestPath)
        : null,
    },
  };
}

export async function updatePhase2Baseline(repositoryRoot, options = {}) {
  if (!options.reason?.trim()) {
    throw new Error("更新冻结基线必须通过 --reason 记录原因");
  }

  const root = path.resolve(repositoryRoot);
  const outputDirectory = path.join(root, "baselines", CANDIDATE_BASELINE_ID);
  const apiOutputDirectory = path.join(outputDirectory, PUBLIC_API_DIRECTORY);
  const { snapshot, contents } = await collectPhase2Baseline(root, {
    capturedAt: options.capturedAt,
    capturePlatform: options.capturePlatform,
    updateReason: options.reason.trim(),
    baselineId: CANDIDATE_BASELINE_ID,
  });

  await mkdir(apiOutputDirectory, { recursive: true });
  for (const [packageName, content] of Object.entries(contents)) {
    await writeFile(path.join(apiOutputDirectory, `${packageName}.d.ts`), content, "utf8");
  }
  await writeFile(
    path.join(outputDirectory, "baseline.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  return snapshot;
}

export async function verifyPhase2Baseline(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const baselineId = resolveActiveBaselineId(root);
  const baselinePath = path.join(root, "baselines", baselineId, "baseline.json");
  if (!existsSync(baselinePath)) {
    throw new Error(`冻结基线不存在：${baselinePath}`);
  }
  const expected = await readJson(baselinePath);
  const actual = await capturePhase2Baseline(root, { baselineId });
  return evaluatePhase2Baseline(expected, actual);
}

export function resolveActiveBaselineId(repositoryRoot) {
  const candidatePath = path.join(
    path.resolve(repositoryRoot),
    "baselines",
    CANDIDATE_BASELINE_ID,
    "baseline.json",
  );
  return existsSync(candidatePath) ? CANDIDATE_BASELINE_ID : REFERENCE_BASELINE_ID;
}

function compareValue(expected, actual, path, blockers) {
  if (ignoredContractPaths.has(path)) return;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!sameJson(expected, actual)) blockers.push(`${path} 与冻结基线不一致`);
    return;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      compareValue(expected[key], actual[key], path ? `${path}.${key}` : key, blockers);
    }
    return;
  }
  if (isCoverageNumber(path, expected, actual)) {
    if (actual < expected) blockers.push(`${path} 低于冻结基线 ${expected}（当前 ${actual}）`);
    return;
  }
  if (!Object.is(expected, actual)) blockers.push(`${path} 与冻结基线不一致`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isCoverageNumber(pathValue, expected, actual) {
  return (
    pathValue.startsWith("quality.coverage.") &&
    typeof expected === "number" &&
    typeof actual === "number"
  );
}

async function collectPhase2Baseline(root, evidenceOptions) {
  const { hashes, contents } = await collectPublicApiSnapshots(root);
  return {
    snapshot: await assemblePhase2Baseline(
      root,
      evidenceOptions,
      hashes,
      evidenceOptions.baselineId ?? resolveActiveBaselineId(root),
    ),
    contents,
  };
}

async function collectPublicApiSnapshots(root) {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "coremind-phase2-baseline-"));
  try {
    const packages = await discoverPublicPackages(root);
    const entries = await Promise.all(
      packages.map(async ({ directory, name }) => {
        const projectFolder = path.join(root, PACKAGE_DIRECTORY, directory);
        const outputPath = path.join(temporaryRoot, `${name}.d.ts`);
        const entryPoint = path.join(projectFolder, "dist", "index.d.ts");
        if (!existsSync(entryPoint)) {
          throw new Error(`缺少正式构建产物：${entryPoint}；请先运行 npm run build`);
        }
        const messages = [];
        const extractorConfig = ExtractorConfig.prepare({
          configObject: {
            projectFolder,
            mainEntryPointFilePath: "<projectFolder>/dist/index.d.ts",
            compiler: { tsconfigFilePath: "<projectFolder>/tsconfig.build.json" },
            apiReport: { enabled: false },
            docModel: { enabled: false },
            dtsRollup: { enabled: true, untrimmedFilePath: outputPath },
            tsdocMetadata: { enabled: false },
          },
          configObjectFullPath: undefined,
          packageJsonFullPath: path.join(projectFolder, "package.json"),
        });
        const result = Extractor.invoke(extractorConfig, {
          localBuild: true,
          showVerboseMessages: false,
          messageCallback: (message) => messages.push(message.text),
        });
        if (!result.succeeded) {
          throw new Error(
            `无法采集 ${name} 的公开 API：${messages.filter(Boolean).join("；") || "未知错误"}`,
          );
        }
        const content = normalizeText(await readFile(outputPath, "utf8"));
        return [name, content];
      }),
    );
    const contents = Object.fromEntries(
      entries.sort(([left], [right]) => left.localeCompare(right)),
    );
    return {
      contents,
      hashes: Object.fromEntries(
        Object.entries(contents).map(([name, content]) => [name, hashText(content)]),
      ),
    };
  } finally {
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedSystemTemp = path.resolve(tmpdir());
    if (resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
      await rm(resolvedTemporaryRoot, { recursive: true, force: true });
    }
  }
}

async function discoverPublicPackages(root) {
  const packagesRoot = path.join(root, PACKAGE_DIRECTORY);
  const entries = await readdir(packagesRoot, { withFileTypes: true });
  const packages = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = await readJson(manifestPath);
    if (!manifest.private && manifest.types) {
      packages.push({ directory: entry.name, name: manifest.name });
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

async function importBuiltPackage(root, directory, cacheKey) {
  const entryPoint = path.join(root, PACKAGE_DIRECTORY, directory, "dist", "index.js");
  if (!existsSync(entryPoint)) {
    throw new Error(`缺少正式构建产物：${entryPoint}；请先运行 npm run build`);
  }
  return import(
    `${pathToFileURL(entryPoint).href}?baseline=${encodeURIComponent(cacheKey ?? Date.now())}`
  );
}

function collectDependencyVersions(packageLock) {
  const result = {};
  for (const [alias, packageName] of Object.entries(dependencyPackages)) {
    const suffix = `node_modules/${packageName}`;
    result[alias] = [
      ...new Set(
        Object.entries(packageLock.packages ?? {})
          .filter(([packagePath, metadata]) => packagePath.endsWith(suffix) && metadata?.version)
          .map(([, metadata]) => metadata.version),
      ),
    ].sort();
  }
  return result;
}

async function discoverCodingEvalProfiles(root) {
  const entries = await readdir(path.join(root, "examples", "coding-evals"), {
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-defect"))
    .map((entry) => entry.name.slice(0, -"-defect".length))
    .sort();
}

async function hashDirectory(directory) {
  if (!existsSync(directory)) throw new Error(`待哈希目录不存在：${directory}`);
  const files = await listFiles(directory);
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = path.relative(directory, file).split(path.sep).join("/");
    hash.update(relativePath, "utf8");
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function listFiles(directory) {
  const result = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if ([".coremind", ".git", "dist", "node_modules"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await listFiles(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

async function hashFile(filePath) {
  return hashBuffer(await readFile(filePath));
}

function hashCanonicalValue(value) {
  return hashText(JSON.stringify(sortValue(value)));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function hashText(value) {
  return hashBuffer(Buffer.from(value, "utf8"));
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value) {
  return `${value.replace(/\r\n/g, "\n").trimEnd()}\n`;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function git(root, arguments_) {
  const result = spawnSync("git", arguments_, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${arguments_.join(" ")} 失败：${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function runCli() {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const reasonIndex = args.indexOf("--reason");
  const reason = reasonIndex >= 0 ? args[reasonIndex + 1] : undefined;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  if (update) {
    await updatePhase2Baseline(root, { reason });
    console.log(`已更新 ${CANDIDATE_BASELINE_ID} 候选基线；参考基线保持不变`);
    return;
  }

  const result = await verifyPhase2Baseline(root);
  if (!result.ready) {
    console.error(`二期冻结基线检查失败：\n- ${result.blockers.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("二期冻结基线检查通过");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
