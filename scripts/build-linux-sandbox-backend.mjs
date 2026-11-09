import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@anthropic-ai", "sandbox-runtime");
const vendor = path.join(root, "packages", "coremind-tools", "src", "vendor", "linux-sandbox");
const seccompInit = { compiler: "zig", version: "0.15.2", source: "scripts/linux-seccomp-init.c" };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function verifyLinuxSandboxBackend(directory = vendor) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.source.version, "0.0.71", "Linux 后端来源版本不匹配");
  assert.deepEqual(manifest.build.seccompInit, seccompInit, "Linux helper 构建来源不匹配");
  assert.equal(
    manifest.source.files[seccompInit.source],
    digest(await readFile(path.join(root, seccompInit.source))),
    "Linux helper 源码摘要不匹配",
  );
  assert.equal(typeof manifest.artifacts["musl-COPYRIGHT"], "string", "缺少 musl 许可证摘要");
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

function replaceSection(content, start, end, replacement) {
  const first = content.indexOf(start);
  const last = content.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last >= 0, "Linux 后端固定来源锚点不匹配");
  assert.equal(content.indexOf(start, first + start.length), -1, "Linux 后端来源锚点不唯一");
  return content.slice(0, first) + replacement + content.slice(last);
}

function strictLinuxBackend(content) {
  const restrictions = "    // Determine if we have restrictions to apply";
  const patched = replaceSection(
    content,
    restrictions,
    "\n    // Read: denyOnly pattern",
    [
      "    if (needsNetworkRestriction !== true || writeConfig === undefined || enableWeakerNestedSandbox !== false ||",
      "        allowAllUnixSockets !== false || httpSocketPath !== undefined || socksSocketPath !== undefined ||",
      "        httpProxyPort !== undefined || socksProxyPort !== undefined || proxyAuthToken !== undefined ||",
      "        caCertPath !== undefined || socatPath !== undefined || observeSocketPath !== undefined ||",
      "        bwrapPath !== undefined ||",
      "        !path.isAbsolute(seccompConfig?.applyPath ?? '')) {",
      "        throw new Error('Linux 后端仅支持严格断网与固定 seccomp helper');",
      "    }",
      restrictions,
    ].join("\n"),
  );
  const fixedNamespaces = replaceSection(
    patched,
    "        if (!enableWeakerNestedSandbox) {",
    "        // Resolve the full path to the shell binary",
    "        bwrapArgs.push('--unshare-user', '--cap-drop', 'ALL', '--proc', '/proc', '--disable-userns', '--as-pid-1');\n",
  );
  // 在 bwrap 内直接启动受信 PID 1，业务 shell 只在加载过滤器后执行。
  return replaceSection(
    fixedNamespaces,
    "        bwrapArgs.push('--', shell, '-c');",
    "        const wrappedCommand =",
    "        bwrapArgs.push('--', seccompConfig.applyPath, shell, '-c', command);\n",
  );
}

async function compileSeccompInit(artifacts) {
  const configuredZig = process.env.COREMIND_ZIG;
  if (configuredZig !== undefined)
    assert.ok(path.isAbsolute(configuredZig), "COREMIND_ZIG 必须是绝对路径");
  const zig = configuredZig ?? seccompInit.compiler;
  assert.equal(
    execFileSync(zig, ["version"], { encoding: "utf8" }).trim(),
    seccompInit.version,
    "Linux helper 需要固定 Zig 版本",
  );
  const environment = execFileSync(zig, ["env"], { cwd: root, encoding: "utf8" });
  const libraryPath = /^\s*\.lib_dir\s*=\s*("(?:[^"\\]|\\.)*"),\s*$/mu.exec(environment)?.[1];
  assert.ok(libraryPath, "无法定位固定 Zig 版本的 musl 许可证");
  artifacts.set(
    "musl-COPYRIGHT",
    await readFile(path.resolve(root, JSON.parse(libraryPath), "libc", "musl", "COPYRIGHT")),
  );
  const temporaryRoot = path.resolve(tmpdir());
  const prefix = "coremind-build-linux-seccomp-";
  const temporary = await mkdtemp(path.join(temporaryRoot, prefix));
  try {
    for (const [arch, target] of [
      ["x64", "x86_64-linux-musl"],
      ["arm64", "aarch64-linux-musl"],
    ]) {
      const output = path.join(temporary, arch);
      execFileSync(
        zig,
        [
          "cc",
          "-target",
          target,
          "-static",
          "-O2",
          "-s",
          "-Wl,--build-id=none",
          seccompInit.source,
          "-o",
          output,
        ],
        { cwd: root, stdio: "inherit" },
      );
      artifacts.set(`bin/${arch}/apply-seccomp`, await readFile(output));
    }
  } finally {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), temporaryRoot, "拒绝清理临时目录外的路径");
    assert.ok(path.basename(resolved).startsWith(prefix), "拒绝清理非本次构建目录");
    await rm(resolved, { recursive: true, force: true });
  }
}

export async function buildLinuxSandboxBackend() {
  const packageManifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
  assert.equal(packageManifest.version, "0.0.71", "更新来源前必须重新审查 Linux 安全合同");
  const entry = [
    'export { wrapCommandWithSandboxLinux, checkLinuxDependencies, cleanupBwrapMountPoints } from "./dist/sandbox/linux-sandbox-utils.js";',
    'export { getDefaultWritePaths } from "./dist/sandbox/sandbox-utils.js";',
    'export { hasRipgrepSync } from "./dist/utils/ripgrep.js";',
  ].join("\n");
  const upstream = path.join(source, "dist", "sandbox", "linux-sandbox-utils.js");
  let patched = false;
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
    plugins: [
      {
        name: "coremind-linux-seccomp-init",
        setup(plugin) {
          plugin.onLoad({ filter: /linux-sandbox-utils\.js$/ }, async ({ path: filename }) => {
            if (path.relative(upstream, filename) !== "") return undefined;
            const contents = strictLinuxBackend(await readFile(filename, "utf8"));
            patched = true;
            return { contents, resolveDir: path.dirname(filename), loader: "js" };
          });
        },
      },
    ],
  });
  assert.ok(patched, "Linux 后端生成未应用严格启动路径");
  const artifacts = new Map([
    ["backend.mjs", result.outputFiles[0].contents],
    ["LICENSE", await readFile(path.join(source, "LICENSE"))],
    ["metafile.json", Buffer.from(json(result.metafile), "utf8")],
  ]);
  await compileSeccompInit(artifacts);
  const sourceFiles = {
    [seccompInit.source]: digest(await readFile(path.join(root, seccompInit.source))),
  };
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
    build: {
      esbuild: (await import("esbuild")).version,
      entry,
      network: "denied",
      proxies: false,
      seccompInit,
    },
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
