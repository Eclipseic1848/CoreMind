import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function decideExistingPyPiArtifact(localSha256, releases, filename) {
  const existing = releases.find((item) => item.filename === filename);
  if (!existing) return "publish";
  if (existing.digests?.sha256 === localSha256) return "skip-identical";
  return "conflict";
}

async function verify(rootDirectory) {
  const manifest = JSON.parse(
    await readFile(path.join(rootDirectory, "release-manifest.json"), "utf8"),
  );
  const wheels = (manifest.artifacts ?? []).filter((item) => item.kind === "python");
  if (wheels.length !== 1) throw new Error(`Python wheel 数量应为 1，实际为 ${wheels.length}`);
  const wheel = wheels[0];
  const wheelPath = path.resolve(rootDirectory, wheel.path);
  if (
    !wheelPath.startsWith(`${path.resolve(rootDirectory)}${path.sep}`) ||
    !existsSync(wheelPath)
  ) {
    throw new Error(`Python wheel 不存在或越界：${wheel.path}`);
  }
  const localSha256 = createHash("sha256")
    .update(await readFile(wheelPath))
    .digest("hex");
  const pypiVersion = manifest.version
    .replace(/-alpha\.(\d+)$/, "a$1")
    .replace(/-beta\.(\d+)$/, "b$1")
    .replace(/-rc\.(\d+)$/, "rc$1");
  const response = await fetch(`https://pypi.org/pypi/coremind-ai/${pypiVersion}/json`);
  if (response.status === 404) {
    console.log("publish");
    return;
  }
  if (!response.ok) throw new Error(`PyPI 查询失败：HTTP ${response.status}`);
  const payload = await response.json();
  const decision = decideExistingPyPiArtifact(
    localSha256,
    payload.urls ?? [],
    path.basename(wheelPath),
  );
  if (decision === "conflict") {
    throw new Error(
      `PyPI 已存在同名同版本 wheel，但 SHA-256 与本次发布物不一致：${path.basename(wheelPath)}`,
    );
  }
  console.log(decision);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verify(path.resolve(process.argv[2] ?? path.join(repositoryRoot, "release-artifacts")));
}
