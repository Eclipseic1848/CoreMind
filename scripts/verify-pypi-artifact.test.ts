import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decideExistingPyPiArtifact,
  manifestWheels,
  stagePyPiUploads,
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

  it("四项公开版本各自返回 404 时只列为待上传，不把它当首次 OIDC 注册证明", async () => {
    const { root, target, manifest } = fixture();
    const calls: string[] = [];
    const request = async (url: string) => {
      calls.push(url);
      return new Response(null, { status: 404 });
    };
    expect(await stagePyPiUploads(root, manifest, target, request)).toBe("publish");
    expect(calls).toEqual(
      manifest.artifacts.map((a) => `https://pypi.org/pypi/${a.name}/${a.version}/json`),
    );
    expect(readdirSync(target).sort()).toEqual(
      manifest.artifacts.map((a) => path.basename(a.path)).sort(),
    );
  });

  it("部分发布只暂存缺失项目，全部相同时跳过上传", async () => {
    const { root, target, manifest } = fixture();
    const request = (missing: string) => async (url: string) => {
      const wheel = manifest.artifacts.find((a) => url.endsWith(`/${a.name}/${a.version}/json`))!;
      if (wheel.name === missing) return new Response(null, { status: 404 });
      return Response.json({
        urls: [{ filename: path.basename(wheel.path), digests: { sha256: wheel.sha256 } }],
      });
    };
    for (const artifact of manifest.artifacts) {
      const directory = path.join(target, artifact.name);
      expect(await stagePyPiUploads(root, manifest, directory, request(artifact.name))).toBe(
        "publish",
      );
      expect(readdirSync(directory)).toEqual([path.basename(artifact.path)]);
    }
    const allIdentical = path.join(target, "all-identical");
    expect(await stagePyPiUploads(root, manifest, allIdentical, request(""))).toBe(
      "skip-identical",
    );
    expect(existsSync(allIdentical)).toBe(false);
  });

  it("任意一项哈希冲突、权限错误或查询失败均阻止整批暂存", async () => {
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
      await expect(stagePyPiUploads(root, manifest, target, request)).rejects.toThrow();
      expect(existsSync(target)).toBe(false);
    }
    writeFileSync(path.join(root, last.path), "changed", "utf8");
    await expect(
      stagePyPiUploads(root, manifest, target, async () => new Response(null, { status: 404 })),
    ).rejects.toThrow("本地 wheel");
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
