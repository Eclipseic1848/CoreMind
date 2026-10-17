import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, version as esbuildVersion } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsSource = path.join(root, "packages", "coremind-tools", "src");
const vendor = path.join(toolsSource, "vendor", "windows-mcp");
const identity = path.join(toolsSource, "windows-mcp-service-identity.ts");
const entry = "packages/coremind-tools/src/windows-mcp-service.mts";
const guardEntry = "packages/coremind-tools/src/windows-mcp-job-guard.cs";
const guardReferenceNames = ["mscorlib.dll", "System.dll", "System.Core.dll"];
const guardCompilerOptions = [
  "/nologo",
  "/noconfig",
  "/nostdlib+",
  "/utf8output",
  "/codepage:65001",
  "/target:library",
  "/platform:anycpu",
  "/optimize+",
  "/debug-",
];
const managedArtifacts = {
  guard: {
    name: "guard",
    entry: guardEntry,
    filename: "guard.dll",
    identity: "WINDOWS_MCP_GUARD",
    compilerOptions: guardCompilerOptions,
  },
  host: {
    name: "host",
    entry: "packages/coremind-tools/src/windows-mcp-console-host.cs",
    filename: "host.exe",
    identity: "WINDOWS_MCP_HOST",
    compilerOptions: guardCompilerOptions.map((option) =>
      option === "/target:library" ? "/target:exe" : option,
    ),
  },
};
const artifactNames = [
  "service.mjs",
  "THIRD-PARTY-LICENSES.txt",
  "metafile.json",
  "guard.dll",
  "host.exe",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function verifyWindowsMcpManagedArtifact(directory, manifest, artifact) {
  const record = manifest[artifact.name];
  const sourceHash = digest(await readFile(path.join(root, artifact.entry)));
  const fixed = await readFile(identity, "utf8");
  const expectedHash = new RegExp(`${artifact.identity}_SHA256 =\\s*"([0-9a-f]{64})"`, "u").exec(
    fixed,
  )?.[1];
  const expectedSource = new RegExp(
    `${artifact.identity}_SOURCE_SHA256 =\\s*"([0-9a-f]{64})"`,
    "u",
  ).exec(fixed)?.[1];
  assert.equal(
    record?.source?.entry,
    artifact.entry,
    `Windows MCP ${artifact.name} 缺少固定编译来源`,
  );
  assert.equal(
    record.source.sha256,
    sourceHash,
    `Windows MCP ${artifact.name} 源码已变化，必须在 Windows 显式重新生成`,
  );
  assert.equal(sourceHash, expectedSource, `Windows MCP ${artifact.name} 固定源码身份不匹配`);
  assert.equal(record.compiler?.name, "csc.exe", `Windows MCP ${artifact.name} 编译器记录无效`);
  assert.match(
    record.compiler?.sha256 ?? "",
    /^[0-9a-f]{64}$/u,
    `Windows MCP ${artifact.name} 编译器摘要无效`,
  );
  assert.equal(record.compiler.exitCode, 0, `Windows MCP ${artifact.name} 编译未成功`);
  assert.deepEqual(
    record.compiler.options,
    artifact.compilerOptions,
    `Windows MCP ${artifact.name} 编译选项无效`,
  );
  assert.deepEqual(
    Object.keys(record.compiler.references ?? {}).sort(),
    [...guardReferenceNames].sort(),
    `Windows MCP ${artifact.name} Framework 引用无效`,
  );
  for (const name of guardReferenceNames)
    assert.match(
      record.compiler.references[name],
      /^[0-9a-f]{64}$/u,
      `Windows MCP ${artifact.name} 引用摘要无效`,
    );
  const bytes = await readFile(path.join(directory, artifact.filename));
  assert.equal(
    digest(bytes),
    manifest.artifacts[artifact.filename],
    `Windows MCP ${artifact.name} 资产摘要不匹配`,
  );
  assert.equal(digest(bytes), expectedHash, `Windows MCP ${artifact.name} 固定身份不匹配`);
  return { record, bytes };
}

async function rebuildWindowsMcpManagedArtifact(artifact) {
  assert.equal(
    process.platform,
    "win32",
    `${artifact.name} 必须在 Windows 使用 Framework 编译器显式生成`,
  );
  const windows = process.env.SystemRoot ?? process.env.windir;
  assert.ok(windows && /^[a-z]:[/\\]/iu.test(windows), "无法确定 Windows Framework 目录");
  const framework = path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319");
  const compiler = path.join(framework, "csc.exe");
  const inputs = [
    path.join(root, artifact.entry),
    compiler,
    ...guardReferenceNames.map((name) => path.join(framework, name)),
  ];
  const hashes = new Map();
  for (const filename of inputs) hashes.set(filename, digest(await readFile(filename)));
  const prefix = `coremind-windows-mcp-${artifact.name}-`;
  const temporary = await mkdtemp(path.join(os.tmpdir(), prefix));
  let generated;
  let failed;
  try {
    const output = path.join(temporary, artifact.filename);
    execFileSync(
      compiler,
      [
        ...artifact.compilerOptions,
        `/out:${output}`,
        ...guardReferenceNames.map((name) => `/reference:${path.join(framework, name)}`),
        path.join(root, artifact.entry),
      ],
      { cwd: root, encoding: "utf8", windowsHide: true, timeout: 60_000 },
    );
    // 编译后复核同一组输入，拒绝把并发变化的源或工具记为已编译来源。
    for (const filename of inputs)
      assert.equal(
        digest(await readFile(filename)),
        hashes.get(filename),
        `${artifact.name} 编译输入在生成期间发生变化`,
      );
    const bytes = await readFile(output);
    assert.ok(
      bytes.length > 64 && bytes[0] === 0x4d && bytes[1] === 0x5a,
      `${artifact.name} 编译输出不是 PE 资产`,
    );
    generated = {
      bytes,
      record: {
        source: { entry: artifact.entry, sha256: hashes.get(path.join(root, artifact.entry)) },
        compiler: {
          name: "csc.exe",
          sha256: hashes.get(compiler),
          options: [...artifact.compilerOptions],
          references: Object.fromEntries(
            guardReferenceNames.map((name) => [name, hashes.get(path.join(framework, name))]),
          ),
          exitCode: 0,
        },
      },
    };
  } catch (error) {
    failed = error;
  }
  try {
    const target = path.resolve(temporary);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()), "拒绝清理非自有临时目录");
    assert.ok(path.basename(target).startsWith(prefix), "拒绝清理非自有临时目录");
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    if (failed)
      throw new AggregateError([failed, error], `${artifact.name} 生成与临时目录清理失败`);
    throw error;
  }
  if (failed) throw failed;
  return generated;
}

async function verifyWindowsMcpHostConfiguration(directory) {
  await assert.rejects(
    lstat(path.join(directory, "host.exe.config")),
    { code: "ENOENT" },
    "Windows MCP host 不允许旁置配置",
  );
}

export async function verifyWindowsMcpService(directory = vendor) {
  await verifyWindowsMcpHostConfiguration(directory);
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
  await verifyWindowsMcpManagedArtifact(directory, manifest, managedArtifacts.guard);
  await verifyWindowsMcpManagedArtifact(directory, manifest, managedArtifacts.host);
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

export async function buildWindowsMcpService({ rebuildGuard = false, rebuildHost = false } = {}) {
  await verifyWindowsMcpHostConfiguration(vendor);
  // 先验证所有复用资产；单独重建一个宿主不能重新编译或登记另一个资产。
  const previous = JSON.parse(await readFile(path.join(vendor, "manifest.json"), "utf8"));
  let guard;
  let host;
  if (!rebuildGuard)
    guard = await verifyWindowsMcpManagedArtifact(vendor, previous, managedArtifacts.guard);
  if (!rebuildHost)
    host = await verifyWindowsMcpManagedArtifact(vendor, previous, managedArtifacts.host);
  if (rebuildGuard) guard = await rebuildWindowsMcpManagedArtifact(managedArtifacts.guard);
  if (rebuildHost) host = await rebuildWindowsMcpManagedArtifact(managedArtifacts.host);
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
    ["guard.dll", guard.bytes],
    ["host.exe", host.bytes],
  ]);
  const manifest = {
    schemaVersion: 1,
    source: { entry, files, packages },
    guard: guard.record,
    host: host.record,
    build: { esbuild: esbuildVersion },
    artifacts: Object.fromEntries([...artifacts].map(([name, bytes]) => [name, digest(bytes)])),
  };
  await mkdir(vendor, { recursive: true });
  for (const [filename, bytes] of artifacts) await writeFile(path.join(vendor, filename), bytes);
  await writeFile(path.join(vendor, "manifest.json"), json(manifest), "utf8");
  await writeFile(
    identity,
    `// 固定启动器身份；由构建脚本生成，普通构建只校验。\nexport const WINDOWS_MCP_SERVICE_SHA256 =\n  "${manifest.artifacts["service.mjs"]}";\nexport const WINDOWS_MCP_GUARD_SHA256 =\n  "${manifest.artifacts["guard.dll"]}";\nexport const WINDOWS_MCP_GUARD_SOURCE_SHA256 =\n  "${guard.record.source.sha256}";\nexport const WINDOWS_MCP_HOST_SHA256 =\n  "${manifest.artifacts["host.exe"]}";\nexport const WINDOWS_MCP_HOST_SOURCE_SHA256 =\n  "${host.record.source.sha256}";\n`,
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
    await buildWindowsMcpService({
      rebuildGuard: process.argv.includes("--rebuild-guard"),
      rebuildHost: process.argv.includes("--rebuild-host"),
    });
  }
}
