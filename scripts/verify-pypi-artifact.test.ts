import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideExistingPyPiArtifact,
  manifestWheels,
  stagePyPiUpload,
} from "./verify-pypi-artifact.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = "2.1.0") {
  const root = mkdtempSync(path.join(tmpdir(), "coremind-wheel-test-"));
  roots.push(root);
  mkdirSync(path.join(root, "python"));
  const names = [
    "coremind-ai",
    "coremind-knowledge-mcp",
    "coremind-memory-mcp",
    "coremind-ontology-mcp",
  ];
  const artifacts = (version === "2.0.0" ? names.slice(0, 1) : names).map((name) => {
    const pyVersion = name === "coremind-ai" ? version : "0.1.0";
    const file = `python/${name.replaceAll("-", "_")}-${pyVersion}-py3-none-any.whl`;
    const bytes = Buffer.from(name);
    writeFileSync(path.join(root, file), bytes);
    return {
      kind: "python",
      name,
      version: pyVersion,
      path: file,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  writeFileSync(
    path.join(root, "SHA256SUMS.txt"),
    artifacts.map((item) => `${item.sha256}  ${item.path}`).join("\n"),
    "utf8",
  );
  return { root, target: path.join(root, "stage"), manifest: { version, artifacts } };
}

describe("PyPI 断点发布判定", () => {
  it("只跳过同名且 SHA-256 一致的 wheel", () => {
    const releases = [
      { filename: "coremind_ai-0.3.0rc2-py3-none-any.whl", digests: { sha256: "same" } },
    ];
    expect(
      decideExistingPyPiArtifact("same", releases, "coremind_ai-0.3.0rc2-py3-none-any.whl"),
    ).toBe("skip-identical");
    expect(
      decideExistingPyPiArtifact("other", releases, "coremind_ai-0.3.0rc2-py3-none-any.whl"),
    ).toBe("conflict");
    expect(decideExistingPyPiArtifact("same", releases, "other.whl")).toBe("publish");
  });

  it("各环境只向自己的 PyPI 项目查询，404 时只暂存该项目的 wheel", async () => {
    const { root, target, manifest } = fixture();
    for (const artifact of manifest.artifacts) {
      const directory = path.join(target, artifact.name);
      const calls: string[] = [];
      const request = async (url: string) => {
        calls.push(url);
        return new Response(null, { status: 404 });
      };
      expect(await stagePyPiUpload(root, manifest, artifact.name, directory, request)).toBe(
        "publish",
      );
      expect(calls).toEqual([`https://pypi.org/pypi/${artifact.name}/${artifact.version}/json`]);
      expect(readdirSync(directory)).toEqual([path.basename(artifact.path)]);
    }
  });

  it("同项目已发布相同字节便跳过；拒绝未指定或未知的项目", async () => {
    const { root, target, manifest } = fixture();
    for (const artifact of manifest.artifacts) {
      const request = async () =>
        Response.json({
          urls: [{ filename: path.basename(artifact.path), digests: { sha256: artifact.sha256 } }],
        });
      expect(await stagePyPiUpload(root, manifest, artifact.name, target, request)).toBe(
        "skip-identical",
      );
      expect(existsSync(target)).toBe(false);
    }
    for (const invalid of ["", "other"]) {
      await expect(
        stagePyPiUpload(root, manifest, invalid, target, () => {
          throw new Error("unexpected request");
        }),
      ).rejects.toThrow("当前清单中没有");
    }
  });

  it("SDK 环境仅读取自己的 wheel，并兼容 2.0.0 的单件清单", async () => {
    for (const version of ["2.0.0", "2.1.0"]) {
      const { root, target, manifest } = fixture(version);
      for (const item of manifest.artifacts.slice(1)) rmSync(path.join(root, item.path));
      expect(
        await stagePyPiUpload(
          root,
          manifest,
          "coremind-ai",
          target,
          async () => new Response(null, { status: 404 }),
        ),
      ).toBe("publish");
      expect(readdirSync(target)).toEqual([path.basename(manifest.artifacts[0].path)]);
    }
  });

  it("项目哈希冲突、权限错误或查询失败时阻止该项目上传", async () => {
    const { root, target, manifest } = fixture();
    const last = manifest.artifacts.at(-1)!;
    for (const failure of [
      Response.json({
        urls: [{ filename: path.basename(last.path), digests: { sha256: "0".repeat(64) } }],
      }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 503 }),
    ]) {
      const request = async (url: string) =>
        url.includes(last.name) ? failure : new Response(null, { status: 404 });
      await expect(stagePyPiUpload(root, manifest, last.name, target, request)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
    writeFileSync(path.join(root, last.path), "changed", "utf8");
    await expect(
      stagePyPiUpload(
        root,
        manifest,
        last.name,
        target,
        async () => new Response(null, { status: 404 }),
      ),
    ).rejects.toThrow("本地 wheel");
    expect(existsSync(target)).toBe(false);
    writeFileSync(path.join(root, "SHA256SUMS.txt"), "", "utf8");
    await expect(
      stagePyPiUpload(
        root,
        manifest,
        last.name,
        target,
        async () => new Response(null, { status: 404 }),
      ),
    ).rejects.toThrow("SHA256SUMS.txt");
    expect(existsSync(target)).toBe(false);
  });

  it("2.0.0 保留单 wheel；新版本拒绝缺件、重复项目、额外项目和错误路径", () => {
    const previous = fixture("2.0.0").manifest;
    expect(manifestWheels(previous).map((a) => a.name)).toEqual(["coremind-ai"]);
    const current = fixture().manifest;
    expect(() =>
      manifestWheels({ ...current, artifacts: current.artifacts.slice(0, 1) }),
    ).toThrow();
    for (const change of [
      { name: "unregistered" },
      { name: "coremind-ai" },
      { path: "../test.whl" },
    ]) {
      const artifacts = current.artifacts.map((a, i) => (i === 3 ? { ...a, ...change } : a));
      expect(() => manifestWheels({ ...current, artifacts })).toThrow();
    }
    expect(() =>
      manifestWheels({ ...previous, artifacts: [...previous.artifacts, current.artifacts[1]] }),
    ).toThrow();
  });
});
