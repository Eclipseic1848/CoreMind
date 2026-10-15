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

  it.each([false, true])("拒绝被替换的启动器；同时伪造外部 manifest=%s", async (forgeManifest) => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "coremind-windows-mcp-asset-"));
    try {
      await cp("packages/coremind-tools/src/vendor/windows-mcp", temporary, { recursive: true });
      const replacement = "process.exit(0);\n";
      await writeFile(path.join(temporary, "service.mjs"), replacement, "utf8");
      if (forgeManifest) {
        const filename = path.join(temporary, "manifest.json");
        const manifest = JSON.parse(await readFile(filename, "utf8"));
        manifest.artifacts["service.mjs"] = createHash("sha256").update(replacement).digest("hex");
        await writeFile(filename, JSON.stringify(manifest), "utf8");
      }
      await expect(verifyWindowsMcpService(temporary)).rejects.toThrow(
        forgeManifest ? "固定身份不匹配" : "资产摘要不匹配",
      );
    } finally {
      expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(temporary)).toMatch(/^coremind-windows-mcp-asset-/u);
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
