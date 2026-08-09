import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateCoverage } from "./check-coverage.mjs";

describe("覆盖率基线门禁", () => {
  const baseline = {
    totals: { lines: 60, statements: 60, functions: 60, branches: 50 },
    critical: {
      "packages/coremind-runtime/src/tool-policy.ts": { branches: 75 },
    },
    targets: { total: 80, criticalBranches: 90 },
  };

  it("指标保持或上升时通过，同时报告尚未达到的目标", () => {
    const report = evaluateCoverage(
      {
        total: coverage(65, 64, 70, 55),
        "C:\\repo\\packages\\coremind-runtime\\src\\tool-policy.ts": coverage(90, 90, 90, 80),
      },
      baseline,
    );

    expect(report.ready).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.targetGaps.join("\n")).toContain("全仓");
    expect(report.targetGaps.join("\n")).toContain("tool-policy.ts");
  });

  it("任一全仓或关键模块指标下降时阻止", () => {
    const report = evaluateCoverage(
      {
        total: coverage(59, 64, 70, 55),
        "/repo/packages/coremind-runtime/src/tool-policy.ts": coverage(90, 90, 90, 74),
      },
      baseline,
    );

    expect(report.ready).toBe(false);
    expect(report.blockers.join("\n")).toContain("全仓 lines");
    expect(report.blockers.join("\n")).toContain("tool-policy.ts branches");
  });

  it("按目标平台选择全仓基线，避免平台专属测试造成假回归", () => {
    const platformBaseline = {
      totals: { lines: 50, statements: 50, functions: 50, branches: 50 },
      platforms: {
        win32: { lines: 70, statements: 70, functions: 70, branches: 70 },
        linux: { lines: 60, statements: 60, functions: 60, branches: 60 },
      },
      critical: {},
      targets: { total: 80, criticalBranches: 90 },
    };
    const report = { total: coverage(65, 65, 65, 65) };

    expect(evaluateCoverage(report, platformBaseline, "linux").ready).toBe(true);
    expect(evaluateCoverage(report, platformBaseline, "win32").blockers).toContain(
      "全仓 lines 65% 低于基线 70%",
    );
  });

  it("通用回退基线等于正式平台当前基线的逐项最小值", () => {
    const repositoryBaseline = JSON.parse(
      readFileSync("scripts/coverage-baseline.json", "utf8"),
    ) as {
      totals: Record<string, number>;
      platforms: Record<string, Record<string, number>>;
    };

    for (const metric of ["lines", "statements", "functions", "branches"]) {
      const supportedValues = ["win32", "linux"].map(
        (platform) => repositoryBaseline.platforms[platform][metric],
      );
      expect(repositoryBaseline.totals[metric]).toBe(Math.min(...supportedValues));
    }
  });
});

function coverage(lines: number, statements: number, functions: number, branches: number) {
  return {
    lines: { pct: lines },
    statements: { pct: statements },
    functions: { pct: functions },
    branches: { pct: branches },
  };
}
