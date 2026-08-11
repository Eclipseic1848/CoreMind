import { describe, expect, it } from "vitest";
import { buildDependencyReport } from "./dependency-report.mjs";

describe("核心依赖报告", () => {
  it("记录唯一版本、完整性与 shrinkwrap 决策", async () => {
    const report = await buildDependencyReport(process.cwd(), "2026-08-10");

    expect(report.summary).toEqual({ lockstep: true, version: "0.84.1", packages: 3 });
    expect(report.dependencies).toHaveLength(3);
    expect(report.dependencies.every((item) => item.integrity.startsWith("sha512-"))).toBe(true);
    expect(report.packaging).toEqual({
      cliShrinkwrap: false,
      reason: "CLI 与 SDK 共用工作区 Lockfile、干净安装和 tarball 内容门禁",
    });
  });
});
