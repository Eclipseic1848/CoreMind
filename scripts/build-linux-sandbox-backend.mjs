import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
const vendor = path.join(root, "packages", "coremind-tools", "src", "vendor", "linux-sandbox");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function verifyLinuxSandboxBackend(directory = vendor) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.source.version, "0.0.71", "Linux 后端来源版本不匹配");
  for (const [relative, expected] of Object.entries(manifest.artifacts)) {
    const content = await readFile(path.join(directory, relative));
    assert.equal(digest(content), expected, `Linux 后端资产摘要不匹配：${relative}`);
    if (relative.startsWith("bin/")) {
      assert.equal(content.subarray(0, 4).toString("hex"), "7f454c46", "helper 必须是 ELF");
      assert.equal(content[4], 2, "helper 必须是 64 位 ELF");
      assert.equal(content[5], 1, "helper 必须使用小端编码");
      assert.equal(content.readUInt16LE(18), relative.includes("/x64/") ? 62 : 183);
    }
  }
  const metafile = JSON.parse(await readFile(path.join(directory, "metafile.json"), "utf8"));
  for (const input of Object.keys(metafile.inputs)) {
    assert.doesNotMatch(input, /node-forge|mitm|http-proxy|socks-proxy|sandbox-manager/iu);
  }
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) assert.ok(isBuiltin(imported.path), imported.path);
  }
  return manifest;
}

async function copyAssets(target) {
  await verifyLinuxSandboxBackend();
  await mkdir(target, { recursive: true });
  await cp(vendor, target, { recursive: true, force: true });
  await verifyLinuxSandboxBackend(target);
}

export async function buildLinuxSandboxBackend() {
  const packageManifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  assert.equal(packageManifest.version, "0.0.71", "更新来源前必须重新审查 Linux 安全合同");
  const entry = [
    'export { wrapCommandWithSandboxLinux, checkLinuxDependencies, cleanupBwrapMountPoints } from "./dist/sandbox/linux-sandbox-utils.js";',
    'export { getDefaultWritePaths } from "./dist/sandbox/sandbox-utils.js";',
    'export { hasRipgrepSync } from "./dist/utils/ripgrep.js";',
  ].join("\n");
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: entry, resolveDir: source, sourcefile: "linux-backend-entry.mjs" },
    outfile: "backend.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    metafile: true,
    legalComments: "inline",
    banner: { js: "// 固定来源的私有 Linux 安全后端；由构建脚本生成，请勿手工修改。" },
  });
  const artifacts = new Map([
    ["backend.mjs", result.outputFiles[0].contents],
    ["LICENSE", await readFile(path.join(source, "LICENSE"))],
    ["metafile.json", Buffer.from(json(result.metafile), "utf8")],
  ]);
  for (const arch of ["x64", "arm64"]) {
    artifacts.set(
      `bin/${arch}/apply-seccomp`,
      await readFile(path.join(source, "vendor", "seccomp", arch, "apply-seccomp")),
    );
  }
  const sourceFiles = {};
  for (const relative of Object.keys(result.metafile.inputs)) {
    if (path.basename(relative) === "linux-backend-entry.mjs") continue;
    sourceFiles[relative.replaceAll("\\", "/")] = digest(
      await readFile(path.resolve(root, relative)),
    );
  }
  const manifest = {
    schemaVersion: 1,
    source: {
      package: packageManifest.name,
      version: packageManifest.version,
      license: packageManifest.license,
      files: sourceFiles,
    },
    build: { esbuild: (await import("esbuild")).version, entry, network: "denied", proxies: false },
    artifacts: Object.fromEntries(
      [...artifacts].map(([relative, bytes]) => [relative, digest(bytes)]),
    ),
  };
  await mkdir(vendor, { recursive: true });
  for (const [relative, bytes] of artifacts) {
    const target = path.join(vendor, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(path.join(vendor, "manifest.json"), json(manifest), "utf8");
  await writeFile(
    path.join(vendor, "backend.d.mts"),
    [
      "export interface LinuxBackendParameters {",
      "  command: string; commandId?: string; needsNetworkRestriction: true;",
      "  readConfig: { denyOnly: string[]; allowWithinDeny: string[] };",
      "  writeConfig: { allowOnly: string[]; denyWithinAllow: string[] };",
      "  unsetEnvVars: string[]; enableWeakerNestedSandbox: false; allowAllUnixSockets: false;",
      "  binShell: string; gitSafeDirectories: readonly string[];",
      "  seccompConfig: { applyPath: string }; abortSignal?: AbortSignal;",
      "}",
      "export function wrapCommandWithSandboxLinux(params: LinuxBackendParameters): Promise<string>;",
      "export function checkLinuxDependencies(options: { seccompConfig: { applyPath: string } }): { errors: string[]; warnings: string[] };",
      "export function cleanupBwrapMountPoints(options?: { force?: boolean }): void;",
      "export function getDefaultWritePaths(): string[];",
      "export function hasRipgrepSync(): boolean;",
      "",
    ].join("\n"),
    "utf8",
  );
  await verifyLinuxSandboxBackend();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--copy-only")) {
    await copyAssets(
      path.join(root, "packages", "coremind-tools", "dist", "vendor", "linux-sandbox"),
    );
  } else if (process.argv.includes("--python-assets")) {
    await copyAssets(
      path.join(root, "python", "src", "coremind", "_worker", "vendor", "linux-sandbox"),
    );
  } else if (process.argv.includes("--check")) {
    await verifyLinuxSandboxBackend();
  } else {
    await buildLinuxSandboxBackend();
  }
}
