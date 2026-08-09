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
});

function coverage(lines: number, statements: number, functions: number, branches: number) {
  return {
    lines: { pct: lines },
    statements: { pct: statements },
    functions: { pct: functions },
    branches: { pct: branches },
  };
}
