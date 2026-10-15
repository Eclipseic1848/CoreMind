import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsSource = path.join(root, "packages", "coremind-tools", "src");
const vendor = path.join(toolsSource, "vendor", "windows-mcp");
const identity = path.join(toolsSource, "windows-mcp-service-identity.ts");
const entry = "packages/coremind-tools/src/windows-mcp-service.mts";
const artifactNames = ["service.mjs", "THIRD-PARTY-LICENSES.txt", "metafile.json"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function verifyWindowsMcpService(directory = vendor) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Windows MCP 资产格式无效");
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [...artifactNames].sort());
  for (const relative of artifactNames) {
    assert.match(manifest.artifacts[relative], /^[0-9a-f]{64}$/u);
    assert.equal(
      digest(await readFile(path.join(directory, relative))),
      manifest.artifacts[relative],
      `Windows MCP 资产摘要不匹配：${relative}`,
    );
  }
  const expected = /WINDOWS_MCP_SERVICE_SHA256 =\s*"([0-9a-f]{64})"/u.exec(
    await readFile(identity, "utf8"),
  )?.[1];
  assert.equal(manifest.artifacts["service.mjs"], expected, "Windows MCP 固定身份不匹配");
  assert.equal(
    manifest.source.files[entry],
    digest(await readFile(path.join(root, entry))),
    "Windows MCP 启动器源码已变化，必须重新生成并审查资产",
  );
  const metafile = JSON.parse(await readFile(path.join(directory, "metafile.json"), "utf8"));
  for (const output of Object.values(metafile.outputs)) {
    for (const imported of output.imports) assert.ok(isBuiltin(imported.path), imported.path);
  }
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.ok(manifest.source.packages["node_modules/execa"], "启动器必须沿用锁定的 Execa");
  for (const [relative, metadata] of Object.entries(manifest.source.packages)) {
    const locked = lock.packages[relative];
    assert.equal(metadata.version, locked?.version, `Windows MCP 依赖版本变化：${relative}`);
    assert.equal(metadata.integrity, locked?.integrity, `Windows MCP 依赖身份变化：${relative}`);
  }
  return manifest;
}

async function copyAssets(target) {
  await verifyWindowsMcpService();
  await mkdir(target, { recursive: true });
  await cp(vendor, target, { recursive: true, force: true });
  await verifyWindowsMcpService(target);
}

export async function buildWindowsMcpService() {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: "service.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    write: false,
    metafile: true,
    legalComments: "inline",
    banner: { js: "// Windows MCP 私有启动器；由固定源码与锁定依赖生成，请勿手工修改。" },
  });
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const packages = {};
  const files = {};
  const licenses = new Map();
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    files[input.replaceAll("\\", "/")] = digest(await readFile(path.resolve(root, input)));
    if (!input.replaceAll("\\", "/").startsWith("node_modules/")) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory.startsWith(path.join(root, "node_modules") + path.sep)) {
      let metadata;
      try {
        metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (metadata?.name) {
        const relative = path.relative(root, directory).replaceAll("\\", "/");
        const locked = lock.packages[relative];
        assert.equal(metadata.version, locked?.version);
        assert.ok(locked.integrity, `依赖缺少锁定身份：${metadata.name}`);
        packages[relative] = {
          name: metadata.name,
          version: metadata.version,
          license: metadata.license,
          integrity: locked.integrity,
        };
        if (!licenses.has(relative)) {
          let license;
          for (const filename of [
            "license",
            "LICENSE",
            "LICENSE.md",
            "license.md",
            "LICENSE.txt",
          ]) {
            try {
              license = await readFile(path.join(directory, filename), "utf8");
              break;
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
            }
          }
          assert.ok(license?.trim(), `缺少完整依赖许可：${metadata.name}`);
          licenses.set(relative, `${metadata.name}@${metadata.version}\n${license.trimEnd()}\n`);
        }
        break;
      }
      directory = path.dirname(directory);
    }
  }
  const artifacts = new Map([
    ["service.mjs", Buffer.from(result.outputFiles[0].text.replace(/[ \t]+$/gmu, ""), "utf8")],
    ["THIRD-PARTY-LICENSES.txt", Buffer.from([...licenses.values()].join("\n"), "utf8")],
    ["metafile.json", Buffer.from(json(result.metafile), "utf8")],
  ]);
  const manifest = {
    schemaVersion: 1,
    source: { entry, files, packages },
    build: { esbuild: esbuildVersion },
    artifacts: Object.fromEntries([...artifacts].map(([name, bytes]) => [name, digest(bytes)])),
  };
  await mkdir(vendor, { recursive: true });
  for (const [filename, bytes] of artifacts) await writeFile(path.join(vendor, filename), bytes);
  await writeFile(path.join(vendor, "manifest.json"), json(manifest), "utf8");
  await writeFile(
    identity,
    `// 固定启动器身份；由构建脚本生成，普通构建只校验。\nexport const WINDOWS_MCP_SERVICE_SHA256 =\n  "${manifest.artifacts["service.mjs"]}";\n`,
    "utf8",
  );
  await verifyWindowsMcpService();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--copy-only")) {
    await copyAssets(
      path.join(root, "packages", "coremind-tools", "dist", "vendor", "windows-mcp"),
    );
  } else if (process.argv.includes("--python-assets")) {
    await copyAssets(
      path.join(root, "python", "src", "coremind", "_worker", "vendor", "windows-mcp"),
    );
  } else if (process.argv.includes("--check")) {
    await verifyWindowsMcpService();
  } else {
    await buildWindowsMcpService();
  }
}
