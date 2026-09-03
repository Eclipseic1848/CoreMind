import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseVersion } from "./release-version.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseArtifactRoot = path.join(repositoryRoot, "release-artifacts");
const candidateArtifactRoot = path.join(repositoryRoot, ".scratch", "candidate-artifacts");
const publintCli = path.join(repositoryRoot, "node_modules", "publint", "src", "cli.js");
const attwCli = path.join(
  repositoryRoot,
  "node_modules",
  "@arethetypeswrong",
  "cli",
  "dist",
  "index.js",
);
const NPM_PUBLISH_ORDER = [
  "coremind-config",
  "coremind-protocol",
  "coremind-tools",
  "coremind-templates",
  "coremind-runtime",
  "coremind-ai",
  "coremind-worker",
  "coremind-cli",
];

export function evaluateReleaseIdentity({ version, requestedTag, headSha, tagSha, dirty }) {
  const blockers = [];
  if (requestedTag !== `v${version}`) {
    blockers.push(`请求标签 ${requestedTag} 与版本 ${version} 不一致`);
  }
  if (!tagSha) blockers.push(`标签 ${requestedTag} 不存在`);
  else if (tagSha !== headSha) blockers.push(`标签 ${requestedTag} 未指向当前 HEAD`);
  if (dirty) blockers.push("Git 工作区不干净");
  return blockers;
}

export function evaluateCandidateIdentity({ dirty }) {
  return dirty ? ["Git 工作区不干净"] : [];
}

export function selectNpmDistTag(version) {
  return version.includes("-") ? "next" : "latest";
}

export function validateWaivedRuntimePackage(artifacts, approvedSha256) {
  const runtime = artifacts.find(
    (artifact) => artifact.kind === "npm" && artifact.name === "coremind-runtime",
  );
  if (!runtime) return ["网络豁免发布物缺少 coremind-runtime npm 包"];
  if (runtime.sha256 !== approvedSha256) {
    return ["coremind-runtime npm 包摘要与维护者批准的最终摘要不一致"];
  }
  return [];
}

export async function createArtifactRecords(rootDirectory, files) {
  const records = [];
  for (const file of files) {
    const content = await readFile(file);
    const info = await stat(file);
    records.push({
      path: path.relative(rootDirectory, file).replaceAll("\\", "/"),
      size: info.size,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  }
  return records.sort((left, right) => left.path.localeCompare(right.path));
}

export async function buildReleaseArtifacts(tag, { allowProviderNetworkWaiver = false } = {}) {
  return buildArtifacts({
    tag,
    artifactRoot: releaseArtifactRoot,
    candidate: false,
    allowProviderNetworkWaiver,
  });
}

export async function buildCandidateArtifacts() {
  return buildArtifacts({ artifactRoot: candidateArtifactRoot, candidate: true });
}

async function buildArtifacts({
  tag,
  artifactRoot,
  candidate,
  allowProviderNetworkWaiver = false,
}) {
  const versionReport = await validateReleaseVersion(repositoryRoot);
  if (!versionReport.ready) {
    throw new Error(`发布版本不一致：\n- ${versionReport.blockers.join("\n- ")}`);
  }
  const version = versionReport.npmVersion;
  const headSha = git(["rev-parse", "HEAD"]).stdout.trim();
  const dirty = git(["status", "--porcelain", "--untracked-files=all"]).stdout.trim().length > 0;
  const blockers = candidate
    ? evaluateCandidateIdentity({ dirty })
    : evaluateReleaseIdentity({
        version,
        requestedTag: tag,
        headSha,
        tagSha: git(["rev-list", "-n", "1", tag], { allowFailure: true }).stdout.trim(),
        dirty,
      });
  if (blockers.length > 0) throw new Error(`产物身份检查失败：\n- ${blockers.join("\n- ")}`);

  await resetArtifactDirectory(artifactRoot, candidate);
  const npmDirectory = path.join(artifactRoot, "npm");
  const pythonDirectory = path.join(artifactRoot, "python");
  const sourceDirectory = path.join(artifactRoot, "source");
  await Promise.all([
    mkdir(npmDirectory, { recursive: true }),
    mkdir(pythonDirectory, { recursive: true }),
    mkdir(sourceDirectory, { recursive: true }),
  ]);

  runNpm(["run", "build:python-worker"], repositoryRoot);
  const generatedDiff = git(["status", "--porcelain", "--untracked-files=all"]).stdout.trim();
  if (generatedDiff) {
    throw new Error(`构建改变了候选提交内容，拒绝发布：\n${generatedDiff}`);
  }
  runNpm(
    candidate
      ? ["run", "release:preflight", "--", "--defer-provider-certification"]
      : [
          "run",
          "release:preflight",
          ...(allowProviderNetworkWaiver ? ["--", "--allow-provider-network-waiver"] : []),
        ],
    repositoryRoot,
  );

  const npmArtifacts = [];
  for (const packageName of NPM_PUBLISH_ORDER) {
    const packed = runNpm(
      ["pack", "--workspace", packageName, "--pack-destination", npmDirectory, "--json"],
      repositoryRoot,
      false,
    );
    const payload = JSON.parse(packed.stdout);
    const filename = payload[0]?.filename;
    if (typeof filename !== "string") throw new Error(`${packageName} 未生成 tarball`);
    npmArtifacts.push({
      kind: "npm",
      name: packageName,
      file: path.join(npmDirectory, filename),
    });
    run(
      process.execPath,
      [publintCli, "run", path.join(npmDirectory, filename), "--strict"],
      repositoryRoot,
    );
    run(
      process.execPath,
      [
        attwCli,
        path.join(npmDirectory, filename),
        "--profile",
        "esm-only",
        "--no-emoji",
        "--no-color",
      ],
      repositoryRoot,
    );
  }
  run(
    process.execPath,
    ["scripts/validate-npm-tarballs.mjs", "--directory", npmDirectory],
    repositoryRoot,
  );

  runPython(["-m", "build", "--wheel", "--outdir", pythonDirectory, "python"]);
  const wheels = (await readdir(pythonDirectory))
    .filter((name) => name.endsWith(".whl"))
    .map((name) => path.join(pythonDirectory, name));
  if (wheels.length !== 1) throw new Error(`应生成一个 wheel，实际为 ${wheels.length} 个`);
  runPython(["-m", "twine", "check", wheels[0]]);
  runPython(["-X", "utf8", "scripts/check-python-wheel.py", wheels[0]]);

  const source = path.join(sourceDirectory, `coremind-${version}-source.zip`);
  git([
    "archive",
    "--format=zip",
    `--prefix=coremind-${version}-source/`,
    `--output=${source}`,
    "HEAD",
  ]);
  run(
    process.execPath,
    ["scripts/validate-source-archive.mjs", "--archive", source],
    repositoryRoot,
  );

  const distributables = [
    ...npmArtifacts,
    { kind: "python", name: "coremind-ai", file: wheels[0] },
    { kind: "source", name: "coremind-source", file: source },
  ];
  const records = await createArtifactRecords(
    artifactRoot,
    distributables.map((item) => item.file),
  );
  const metadata = records.map((record) => {
    const sourceItem = distributables.find(
      (item) => path.resolve(item.file) === path.resolve(artifactRoot, record.path),
    );
    return { ...record, kind: sourceItem.kind, name: sourceItem.name, version };
  });
  if (allowProviderNetworkWaiver) {
    const waiver = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "docs",
          "release",
          "evidence",
          "v0.7.0-provider-network-waiver.json",
        ),
        "utf8",
      ),
    );
    const waiverBlockers = validateWaivedRuntimePackage(metadata, waiver.finalRuntimePackageSha256);
    if (waiverBlockers.length > 0) {
      throw new Error(`Provider 网络豁免发布物检查失败：\n- ${waiverBlockers.join("\n- ")}`);
    }
  }
  const manifest = {
    schemaVersion: 1,
    version,
    pythonVersion: versionReport.pythonVersion,
    npmDistTag: selectNpmDistTag(version),
    ...(candidate ? { candidate: true } : { tag }),
    commit: headSha,
    builtAt: new Date().toISOString(),
    artifacts: metadata,
  };
  await writeFile(
    path.join(artifactRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(artifactRoot, "SHA256SUMS.txt"),
    `${metadata.map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`,
    "utf8",
  );
  console.log(
    `${candidate ? "候选" : "发布"}产物构建完成：${version}，${metadata.length} 个文件，提交 ${headSha.slice(0, 12)}`,
  );
  return { artifactRoot, manifest };
}

async function resetArtifactDirectory(artifactRoot, candidate) {
  const resolved = path.resolve(artifactRoot);
  const expected = candidate ? candidateArtifactRoot : releaseArtifactRoot;
  if (resolved !== expected) {
    throw new Error(`拒绝清理非预期目录：${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
}

function runNpm(args, cwd, echo = true) {
  const npmCli = process.env.npm_execpath;
  return npmCli
    ? run(process.execPath, [npmCli, ...args], cwd, false, echo)
    : run(
        process.platform === "win32" ? "npm.cmd" : "npm",
        args,
        cwd,
        process.platform === "win32",
        echo,
      );
}

function runPython(args) {
  return run(process.platform === "win32" ? "python.exe" : "python", args, repositoryRoot);
}

function git(args, options = {}) {
  return run(
    "git",
    args,
    repositoryRoot,
    false,
    options.echo ?? true,
    options.allowFailure ?? false,
  );
}

function run(command, args, cwd, shell = false, echo = true, allowFailure = false) {
  const completed = spawnSync(command, args, {
    cwd,
    shell,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  if (echo && completed.stdout) process.stdout.write(completed.stdout);
  if (echo && completed.stderr) process.stderr.write(completed.stderr);
  if (!allowFailure && completed.status !== 0) {
    throw new Error(`命令失败（${completed.status}）：${command} ${args.join(" ")}`);
  }
  return completed;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const tagIndex = process.argv.indexOf("--tag");
  const tag = tagIndex >= 0 ? process.argv[tagIndex + 1] : process.env.COREMIND_RELEASE_TAG;
  if (!tag) throw new Error("请通过 --tag vX.Y.Z 或 COREMIND_RELEASE_TAG 指定发布标签");
  await buildReleaseArtifacts(tag, {
    allowProviderNetworkWaiver: process.argv.includes("--allow-provider-network-waiver"),
  });
}
