import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metrics = ["lines", "statements", "functions", "branches"];

export function evaluateCoverage(summary, baseline, platform = process.platform) {
  const blockers = [];
  const targetGaps = [];
  const total = summary.total;
  if (!total) return { ready: false, blockers: ["覆盖率报告缺少 total"], targetGaps };
  const totalFloors = baseline.platforms?.[platform] ?? baseline.totals;

  for (const metric of metrics) {
    compareFloor(`全仓 ${metric}`, total[metric]?.pct, totalFloors?.[metric], blockers);
    if (Number(total[metric]?.pct) < Number(baseline.targets?.total)) {
      targetGaps.push(`全仓 ${metric} ${total[metric]?.pct}% < 目标 ${baseline.targets?.total}%`);
    }
  }

  const normalizedEntries = Object.entries(summary).map(([file, value]) => [
    normalize(file),
    value,
  ]);
  for (const [relativeFile, floors] of Object.entries(baseline.critical ?? {})) {
    const normalizedFile = normalize(relativeFile);
    const match = normalizedEntries.find(([file]) => file.endsWith(normalizedFile));
    if (!match) {
      blockers.push(`覆盖率报告缺少关键模块：${relativeFile}`);
      continue;
    }
    const report = match[1];
    for (const [metric, floor] of Object.entries(floors)) {
      compareFloor(`${relativeFile} ${metric}`, report[metric]?.pct, floor, blockers);
    }
    const branchPct = Number(report.branches?.pct);
    if (branchPct < Number(baseline.targets?.criticalBranches)) {
      targetGaps.push(
        `${relativeFile} branches ${branchPct}% < 目标 ${baseline.targets?.criticalBranches}%`,
      );
    }
  }

  return { ready: blockers.length === 0, blockers, targetGaps };
}

function compareFloor(label, actualValue, floorValue, blockers) {
  const actual = Number(actualValue);
  const floor = Number(floorValue);
  if (!Number.isFinite(actual) || !Number.isFinite(floor)) {
    blockers.push(`${label} 缺少可比较数值`);
    return;
  }
  if (actual + 0.005 < floor) blockers.push(`${label} ${actual}% 低于基线 ${floor}%`);
}

function normalize(value) {
  return String(value).replaceAll("\\", "/").toLowerCase();
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const summary = JSON.parse(
    await readFile(path.join(repositoryRoot, "coverage", "coverage-summary.json"), "utf8"),
  );
  const baseline = JSON.parse(
    await readFile(path.join(repositoryRoot, "scripts", "coverage-baseline.json"), "utf8"),
  );
  const result = evaluateCoverage(summary, baseline);
  if (result.ready) {
    console.log("覆盖率不下降门禁通过");
    for (const gap of result.targetGaps) console.warn(`目标差距：${gap}`);
  } else {
    console.error(`覆盖率门禁失败：\n- ${result.blockers.join("\n- ")}`);
  }
  if (!result.ready) process.exitCode = 1;
}
