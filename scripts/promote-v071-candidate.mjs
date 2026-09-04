import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactRecords, evaluateReleaseIdentity } from "./release-artifacts.mjs";
import { validateReleaseVersion } from "./release-version.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const approvedManifestSha256 = "0e8799587fdb7fb5fbd1ac401a3a75522827bb9d23d91d9c6cf90188ce53835f";

export async function verifyCandidateFiles(directory, artifacts) {
  for (const artifact of artifacts) {
    assert.match(artifact.path, /^(npm|python|source)\/[a-zA-Z0-9_.-]+$/u, "产物路径越界");
    const file = path.join(directory, artifact.path);
    assert(!(await lstat(path.dirname(file))).isSymbolicLink(), "产物目录不能是符号链接");
    assert((await lstat(file)).isFile(), "产物必须是普通文件");
    const content = await readFile(file);
    assert.equal(content.length, artifact.size, `产物大小不一致：${artifact.path}`);
    assert.equal(
      createHash("sha256").update(content).digest("hex"),
      artifact.sha256,
      `产物摘要不一致：${artifact.path}`,
    );
  }
}

async function promoteCandidate(directory) {
  // 本次授权仅覆盖固定的 0.7.1 候选；后续版本不得复用此路径。
  const manifestBytes = await readFile(path.join(directory, "release-manifest.json"));
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), approvedManifestSha256);
  const candidate = JSON.parse(manifestBytes.toString("utf8"));
  const version = await validateReleaseVersion(repositoryRoot);
  assert(version.ready && version.npmVersion === "0.7.1" && version.pythonVersion === "0.7.1");
  const git = (args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const commit = git(["rev-parse", "HEAD"]);
  assert.deepEqual(
    evaluateReleaseIdentity({
      version: "0.7.1",
      requestedTag: "v0.7.1",
      headSha: commit,
      tagSha: git(["rev-list", "-n", "1", "v0.7.1"]),
      dirty: git(["status", "--porcelain", "--untracked-files=all"]).length > 0,
    }),
    [],
  );
  await verifyCandidateFiles(directory, candidate.artifacts);

  const output = path.join(repositoryRoot, "release-artifacts");
  await mkdir(output); // 已有发布物时失败，禁止覆盖或重建。
  for (const folder of ["npm", "python", "source"]) await mkdir(path.join(output, folder));
  for (const artifact of candidate.artifacts.filter((item) => item.kind !== "source")) {
    await copyFile(
      path.join(directory, artifact.path),
      path.join(output, artifact.path),
      constants.COPYFILE_EXCL,
    );
  }
  const source = candidate.artifacts.find((item) => item.kind === "source");
  git([
    "archive",
    "--format=zip",
    "--prefix=coremind-0.7.1-source/",
    `--output=${path.join(output, source.path)}`,
    "HEAD",
  ]);
  const [sourceRecord] = await createArtifactRecords(output, [path.join(output, source.path)]);
  const { candidate: _candidate, ...original } = candidate;
  const manifest = {
    ...original,
    tag: "v0.7.1",
    commit,
    builtAt: new Date().toISOString(),
    promotedFrom: {
      runId: 33838498153,
      commit: candidate.commit,
      builtAt: candidate.builtAt,
      manifestSha256: approvedManifestSha256,
      providerCertification: "not-run",
    },
    artifacts: candidate.artifacts.map((item) =>
      item.kind === "source" ? { ...item, ...sourceRecord } : item,
    ),
  };
  await verifyCandidateFiles(output, manifest.artifacts);
  await writeFile(
    path.join(output, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await writeFile(
    path.join(output, "SHA256SUMS.txt"),
    `${manifest.artifacts.map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  console.log(`0.7.1 发布物已晋升：9 个包字节不变，仅更新源码 ZIP；Provider 认证未执行。`);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  assert(process.argv[2], "缺少候选目录");
  await promoteCandidate(path.resolve(process.argv[2]));
}
