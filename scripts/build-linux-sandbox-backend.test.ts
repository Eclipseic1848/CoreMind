import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyLinuxSandboxBackend } from "./build-linux-sandbox-backend.mjs";

describe("私有 Linux 后端制品", () => {
  it("来源、依赖图、两架构 ELF 与全部资产摘要一致", async () => {
    const manifest = await verifyLinuxSandboxBackend();
    expect(manifest.source.version).toBe("0.0.71");
    expect(Object.keys(manifest.source.files)).toHaveLength(8);
    expect(manifest.build).toMatchObject({ network: "denied", proxies: false });
    expect(Object.keys(manifest.artifacts)).toContain("bin/x64/apply-seccomp");
    expect(Object.keys(manifest.artifacts)).toContain("bin/arm64/apply-seccomp");
  });

  it("损坏的原生 helper 不得通过复制前验证", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "coremind-backend-artifact-"));
    try {
      await cp("packages/coremind-tools/src/vendor/linux-sandbox", temporary, { recursive: true });
      await writeFile(path.join(temporary, "bin", "x64", "apply-seccomp"), "damaged", "utf8");
      await expect(verifyLinuxSandboxBackend(temporary)).rejects.toThrow("资产摘要不匹配");
    } finally {
      expect(path.dirname(temporary)).toBe(path.resolve(tmpdir()));
      expect(path.basename(temporary)).toMatch(/^coremind-backend-artifact-/);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
