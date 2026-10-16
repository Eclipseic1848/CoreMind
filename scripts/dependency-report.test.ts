import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEPENDENCY_FAMILY, declaredFamilyVersion } from "./dependency-family.mjs";
import { buildDependencyReport } from "./dependency-report.mjs";

describe("核心依赖报告", () => {
  it("记录唯一版本、完整性与 shrinkwrap 决策", async () => {
    const report = await buildDependencyReport(process.cwd(), "2026-08-10");

    const manifests = await Promise.all(
      ["coremind-runtime", "coremind-tools"].map(async (name) =>
        JSON.parse(
          await readFile(path.join(process.cwd(), "packages", name, "package.json"), "utf8"),
        ),
      ),
    );
    const expectedVersion = declaredFamilyVersion(manifests);
    expect(report.summary).toEqual({
      lockstep: true,
      version: expectedVersion,
      packages: DEPENDENCY_FAMILY.length,
    });
    expect(report.dependencies.map((entry) => entry.name)).toEqual(DEPENDENCY_FAMILY);
    expect(report.dependencies.every((item) => item.integrity.startsWith("sha512-"))).toBe(true);
    expect(report.packaging).toEqual({
      cliShrinkwrap: false,
      reason: "发布候选验证 tarball 干净安装的实际依赖图；仓库 overrides 不约束消费者",
    });
  });
});
