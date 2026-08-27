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
await build({
  entryPoints: [path.join(repositoryRoot, "packages", "coremind-worker", "src", "stdio.ts")],
  outfile: workerOutput,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __coremindCreateRequire } from "node:module"; const require = __coremindCreateRequire(import.meta.url);',
  },
});

// 第三方内联文本可能保留空白行缩进；发布前统一清理，保证 Git 格式门禁可重复通过。
const workerBundle = await readFile(workerOutput, "utf8");
const normalizedBundle = workerBundle.replace(/[ \t]+$/gm, "");
await writeFile(workerOutput, normalizedBundle, "utf8");
const pythonProject = await readFile(path.join(repositoryRoot, "python", "pyproject.toml"), "utf8");
const pythonVersion = /^version\s*=\s*"([^"]+)"/m.exec(pythonProject)?.[1];
if (!pythonVersion) throw new Error("python/pyproject.toml 缺少 project.version");
const workerManifest = {
  schemaVersion: 1,
  version: pythonVersion,
  protocolVersion: "1.0",
  bundleSha256: createHash("sha256").update(normalizedBundle, "utf8").digest("hex"),
};
await writeFile(workerManifestOutput, `${JSON.stringify(workerManifest, null, 2)}\n`, "utf8");

const protocolModule = await import(
  pathToFileURL(path.join(repositoryRoot, "packages", "coremind-protocol", "dist", "index.js")).href
);
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
