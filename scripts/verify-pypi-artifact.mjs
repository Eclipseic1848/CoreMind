import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePythonVersion } from "./release-version.mjs";

export function pythonProjectNames(version) {
  normalizePythonVersion(version);
  const [major, minor] = version.split(".").map(Number);
  const names = ["coremind-ai"];
  if (major > 2 || (major === 2 && minor >= 1)) {
    names.push("coremind-knowledge-mcp", "coremind-memory-mcp", "coremind-ontology-mcp");
  }
  return names;
}

export function pythonArtifactRecords(directory, filenames, version) {
  const wheels = filenames.filter((name) => name.endsWith(".whl"));
  const names = pythonProjectNames(version);
  if (wheels.length !== names.length) throw new Error("构建目录中的 Python wheel 数量与版本不匹配");
  return names.map((name) => {
    const prefix = name.replaceAll("-", "_");
    const pattern = new RegExp(
      `^${prefix}-(\\d+\\.\\d+\\.\\d+(?:(?:a|b|rc)\\d+)?)-py3-none-any\\.whl$`,
    );
    const filename = wheels.find((entry) => pattern.test(entry));
    if (!filename) throw new Error(`缺少 ${name} 的 wheel`);
    const wheelVersion = pattern.exec(filename)[1];
    if (name === "coremind-ai" && wheelVersion !== normalizePythonVersion(version)) {
      throw new Error(`SDK wheel ${filename} 与 CoreMind 版本不一致`);
    }
    return {
      kind: "python",
      name,
      version: name === "coremind-ai" ? version : wheelVersion,
      file: path.join(directory, filename),
    };
  });
}

export function manifestWheels(manifest) {
  const wheels = manifest.artifacts.filter((item) => item.kind === "python");
  const names = pythonProjectNames(manifest.version);
  if (wheels.length !== names.length) throw new Error("Python wheel 数量与版本不匹配");
  return names.map((name) => {
    const wheel = wheels.find((item) => item.name === name);
    if (!wheel) throw new Error(`缺少 Python 项目：${name}`);
    const version =
      name === "coremind-ai" ? normalizePythonVersion(manifest.version) : wheel.version;
    const filename = `${name.replaceAll("-", "_")}-${version}-py3-none-any.whl`;
    if (
      (name === "coremind-ai" && wheel.version !== manifest.version) ||
      !/^\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?$/.test(version) ||
      wheel.path !== `python/${filename}` ||
      !/^[a-f0-9]{64}$/.test(wheel.sha256)
    ) {
      throw new Error(`Python wheel 版本、路径或摘要无效：${name}`);
    }
    return { ...wheel, version, filename };
  });
}

export function decideExistingPyPiArtifact(localSha256, releases, filename) {
  const existing = releases.find((item) => item.filename === filename);
  if (!existing) return "publish";
  if (existing.digests?.sha256 === localSha256) return "skip-identical";
  return "conflict";
}

export async function planPyPiUploads(rootDirectory, manifest, request = fetch) {
  const pending = [];
  for (const wheel of manifestWheels(manifest)) {
    const bytes = await readFile(path.join(rootDirectory, wheel.path));
    if (
      createHash("sha256").update(bytes).digest("hex") !== wheel.sha256 ||
      bytes.length !== wheel.size
    ) {
      throw new Error(`本地 wheel 大小或 SHA-256 与清单不符：${wheel.filename}`);
    }
    const response = await request(`https://pypi.org/pypi/${wheel.name}/${wheel.version}/json`);
    if (response.status !== 404 && !response.ok) {
      throw new Error(`PyPI ${wheel.name} 查询失败：HTTP ${response.status}`);
    }
    // 公开 404 只说明该版本未发布；首次上传的权限由 PyPI 在 OIDC 换证和上传时检查。
    const releases = response.status === 404 ? [] : (await response.json()).urls;
    const decision = decideExistingPyPiArtifact(wheel.sha256, releases, wheel.filename);
    if (decision === "conflict") throw new Error(`PyPI wheel SHA-256 冲突：${wheel.filename}`);
    if (decision === "publish") pending.push(wheel);
  }
  return pending;
}

export async function stagePyPiUploads(rootDirectory, manifest, target, request = fetch) {
  const pending = await planPyPiUploads(rootDirectory, manifest, request);
  if (pending.length && target) {
    await mkdir(path.dirname(target), { recursive: true });
    await mkdir(target);
    for (const wheel of pending) {
      await copyFile(path.join(rootDirectory, wheel.path), path.join(target, wheel.filename));
    }
  }
  return pending.length ? "publish" : "skip-identical";
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [, , root = "release-artifacts", mode, target] = process.argv;
  const manifest = JSON.parse(await readFile(path.join(root, "release-manifest.json"), "utf8"));
  if (mode === "--requirements") {
    for (const wheel of manifestWheels(manifest)) {
      console.log(`${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`);
    }
  } else if (mode === "--sdk-filename") {
    console.log(manifestWheels(manifest).find((wheel) => wheel.name === "coremind-ai").filename);
  } else if (!mode || (mode === "--stage" && target)) {
    console.log(await stagePyPiUploads(root, manifest, target));
  } else {
    throw new Error(
      "用法：verify-pypi-artifact.mjs [目录] [--stage 上传目录|--requirements|--sdk-filename]",
    );
  }
}
