import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyWindowsMcpService } from "./build-windows-mcp-service.mjs";

describe("Windows MCP 固定启动器资产", () => {
  it("仅依赖内置模块，保留每个内联依赖的完整许可", async () => {
    const manifest = await verifyWindowsMcpService();
    const notice = await readFile(
      "packages/coremind-tools/src/vendor/windows-mcp/THIRD-PARTY-LICENSES.txt",
      "utf8",
    );
    for (const relative of Object.keys(manifest.source.packages)) {
      const metadata = manifest.source.packages[relative];
      expect(notice).toContain(`${metadata.name}@${metadata.version}`);
      let original: string | undefined;
      for (const filename of ["license", "LICENSE", "LICENSE.md", "license.md", "LICENSE.txt"]) {
        try {
          original = await readFile(path.join(relative, filename), "utf8");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      expect(original?.trim()).toBeTruthy();
      expect(notice).toContain(original!.trimEnd());
    }
  });

  it.each([
    { filename: "service.mjs", forgeManifest: false },
    { filename: "service.mjs", forgeManifest: true },
    { filename: "guard.dll", forgeManifest: false },
    { filename: "guard.dll", forgeManifest: true },
  ])(
    "拒绝被替换的 $filename；同时伪造外部 manifest=$forgeManifest",
    async ({ filename, forgeManifest }) => {
      await withAssets(async (temporary) => {
        const replacement = "process.exit(0);\n";
        await writeFile(path.join(temporary, filename), replacement, "utf8");
        if (forgeManifest) {
          const manifestFilename = path.join(temporary, "manifest.json");
          const manifest = JSON.parse(await readFile(manifestFilename, "utf8"));
          manifest.artifacts[filename] = createHash("sha256").update(replacement).digest("hex");
          await writeFile(manifestFilename, JSON.stringify(manifest), "utf8");
        }
        await expect(verifyWindowsMcpService(temporary)).rejects.toThrow(
          forgeManifest ? "固定身份不匹配" : "资产摘要不匹配",
        );
      });
    },
  );

  it.each(["missing", "source", "compiler", "references", "options"] as const)(
    "拒绝无效的 guard 编译收据 %s",
    async (mode) => {
      await withAssets(async (temporary) => {
        const filename = path.join(temporary, "manifest.json");
        const manifest = JSON.parse(await readFile(filename, "utf8"));
        if (mode === "missing") delete manifest.guard;
        else if (mode === "source") manifest.guard.source.sha256 = "0".repeat(64);
        else if (mode === "compiler") manifest.guard.compiler.sha256 = "invalid";
        else if (mode === "references")
          manifest.guard.compiler.references["other.dll"] = "a".repeat(64);
        else manifest.guard.compiler.options = [];
        await writeFile(filename, JSON.stringify(manifest), "utf8");
        await expect(verifyWindowsMcpService(temporary)).rejects.toThrow();
      });
    },
  );

  it("缺少 guard 时资产校验失败", async () => {
    await withAssets(async (temporary) => {
      await rm(path.join(temporary, "guard.dll"));
      await expect(verifyWindowsMcpService(temporary)).rejects.toThrow();
    });
  });
});

async function withAssets(check: (temporary: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "coremind-windows-mcp-asset-"));
  try {
    await cp("packages/coremind-tools/src/vendor/windows-mcp", temporary, { recursive: true });
    await check(temporary);
  } finally {
    expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(temporary)).toMatch(/^coremind-windows-mcp-asset-/u);
    await rm(temporary, { recursive: true, force: true });
  }
}
