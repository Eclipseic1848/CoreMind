import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pythonPackage = path.join(repositoryRoot, "python", "src", "coremind");
const workerDirectory = path.join(pythonPackage, "_worker");
const workerOutput = path.join(workerDirectory, "coremind-worker.mjs");
const workerManifestOutput = path.join(workerDirectory, "manifest.json");
const errorContractOutput = path.join(pythonPackage, "_error_contract.json");

await mkdir(workerDirectory, { recursive: true });
const workerBuild = await build({
  entryPoints: [path.join(repositoryRoot, "packages", "coremind-worker", "src", "stdio.ts")],
  outfile: workerOutput,
  write: false,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "inline",
  banner: {
    js: 'import { createRequire as __coremindCreateRequire } from "node:module"; const require = __coremindCreateRequire(import.meta.url);',
  },
});
execFileSync(
  process.execPath,
  [path.join(repositoryRoot, "scripts", "build-linux-sandbox-backend.mjs"), "--python-assets"],
  { cwd: repositoryRoot, stdio: "inherit" },
);
await copyMcpLicenseAssets();
execFileSync(
  process.execPath,
  [path.join(repositoryRoot, "scripts", "build-windows-mcp-service.mjs"), "--python-assets"],
  { cwd: repositoryRoot, stdio: "inherit" },
);

// 第三方内联文本可能保留空白行缩进；发布前统一清理，保证 Git 格式门禁可重复通过。
const workerBundle = workerBuild.outputFiles[0].text;
const normalizedBundle = workerBundle.replace(/[ \t]+$/gm, "");
await writeFile(workerOutput, normalizedBundle, "utf8");
const pythonProject = await readFile(path.join(repositoryRoot, "python", "pyproject.toml"), "utf8");
const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pythonProject)?.[1];
if (!pythonVersion) throw new Error("python/pyproject.toml 缺少 project.version");
const protocolModule = await import(
  pathToFileURL(path.join(repositoryRoot, "packages", "coremind-protocol", "dist", "index.js")).href
);
if (!/^sha256:[0-9a-f]{64}$/.test(protocolModule.PROTOCOL_V2_SCHEMA_FINGERPRINT)) {
  throw new Error("coremind-protocol 未导出有效 PROTOCOL_V2_SCHEMA_FINGERPRINT");
}
const workerManifest = {
  schemaVersion: 1,
  version: pythonVersion,
  protocolVersion: "1.0",
  protocolV2Version: "2.0",
  protocolV2SchemaFingerprint: protocolModule.PROTOCOL_V2_SCHEMA_FINGERPRINT,
  bundleSha256: createHash("sha256").update(normalizedBundle, "utf8").digest("hex"),
};
await writeFile(workerManifestOutput, `${JSON.stringify(workerManifest, null, 2)}\n`, "utf8");

if (
  protocolModule.ERROR_CODES === null ||
  typeof protocolModule.ERROR_CODES !== "object" ||
  Array.isArray(protocolModule.ERROR_CODES)
) {
  throw new Error("coremind-protocol 未导出有效 ERROR_CODES");
}
const errorContract = {
  schemaVersion: 1,
  codes: protocolModule.ERROR_CODES,
};
await writeFile(errorContractOutput, `${JSON.stringify(errorContract, null, 2)}\n`, "utf8");

await cp(
  path.join(repositoryRoot, "packages", "coremind-templates", "skills"),
  path.join(pythonPackage, "skills"),
  { recursive: true, force: true },
);

async function copyMcpLicenseAssets() {
  const sources = [
    ["@modelcontextprotocol/client", "LICENSE", "modelcontextprotocol-LICENSE"],
    ["@modelcontextprotocol/core", "LICENSE", "modelcontextprotocol-LICENSE"],
    ["eventsource", "LICENSE", "eventsource-LICENSE"],
    ["eventsource-parser", "LICENSE", "eventsource-parser-LICENSE"],
    ["jose", "LICENSE.md", "jose-LICENSE.md"],
    ["pkce-challenge", "LICENSE", "pkce-challenge-LICENSE"],
    ["undici", "LICENSE", "undici-LICENSE"],
    ["zod", "LICENSE", "zod-LICENSE"],
  ];
  const lock = JSON.parse(await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  const manifest = { schemaVersion: 1, sources: {}, artifacts: {} };
  const artifacts = new Map();
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const [name, licenseFile, licenseArtifact] of sources) {
    let directory = path.dirname(fileURLToPath(import.meta.resolve(name)));
    let metadata;
    // 这七个固定包均从公开入口定位，避免依赖未导出的 package.json 子路径。
    for (let depth = 0; depth < 4; depth++) {
      try {
        const candidate = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
        if (candidate.name === name) {
          metadata = candidate;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      directory = path.dirname(directory);
    }
    const locked = lock.packages[`node_modules/${name}`];
    if (
      !metadata ||
      !locked ||
      metadata.version !== locked.version ||
      metadata.license !== locked.license ||
      typeof locked.integrity !== "string"
    ) {
      throw new Error(`MCP 许可来源与锁定身份不一致：${name}`);
    }
    const files = {};
    for (const filename of [licenseFile, "NOTICE"]) {
      let bytes;
      try {
        bytes = await readFile(path.join(directory, filename));
      } catch (error) {
        if (filename === "NOTICE" && error.code === "ENOENT") continue;
        throw error;
      }
      const artifact =
        filename === licenseFile
          ? licenseArtifact
          : `${name.replace("@", "").replaceAll("/", "-")}-NOTICE`;
      const previous = artifacts.get(artifact);
      if (previous && !previous.equals(bytes)) {
        throw new Error(`共用 MCP 许可原文不一致，必须分别保留：${name}`);
      }
      artifacts.set(artifact, bytes);
      const sha256 = digest(bytes);
      files[filename] = { artifact, sha256 };
      manifest.artifacts[artifact] = sha256;
    }
    manifest.sources[name] = {
      version: metadata.version,
      license: metadata.license,
      integrity: locked.integrity,
      files,
    };
  }
  const target = path.join(workerDirectory, "vendor", "mcp");
  await mkdir(target, { recursive: true });
  // 逐字节保留上游许可，包括许可过渡说明；不按 package.json 的 SPDX 字段重写正文。
  for (const [filename, bytes] of artifacts) await writeFile(path.join(target, filename), bytes);
  await writeFile(
    path.join(target, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}
