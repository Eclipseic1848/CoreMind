import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildRepositoryMap,
  CheckpointManager,
  createEngineeringTaskPlan,
  EngineeringEvidenceLedger,
  inspectCheckpoint,
  inspectCodingRepository,
  restoreCheckpoint,
  selectCodingEnvironment,
} from "coremind-ai";
import { describe, expect, it } from "vitest";

type Fixture = {
  language: "typescript" | "python";
  source: string;
  targetCommand: { command: string; args: string[] };
  regressionCommand: { command: string; args: string[] };
  repair: string;
};

const fixtures: Fixture[] = [
  {
    language: "typescript",
    source: "src/rate.ts",
    targetCommand: { command: process.execPath, args: ["--test", "tests/price.test.ts"] },
    regressionCommand: { command: process.execPath, args: ["--test"] },
    repair: "export const RATE = 0.2;\n",
  },
  {
    language: "python",
    source: "src/rate.py",
    targetCommand: { command: "python", args: ["-B", "-m", "unittest", "tests.test_price"] },
    regressionCommand: {
      command: "python",
      args: ["-B", "-m", "unittest", "discover", "-s", "tests"],
    },
    repair: "RATE = 0.2\n",
  },
];

describe.each(fixtures)("$language Coding Kernel 跨文件验收", (fixture) => {
  it("保留失败证据，写前建 checkpoint，修复后验证，并可完整恢复", async () => {
    const root = createFixture(fixture.language);
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {
      language: fixture.language,
      testCommand: commandText(fixture.regressionCommand),
    });
    const repoMap = buildRepositoryMap(inspection, selection);
    const plan = createEngineeringTaskPlan({
      task: "修复跨文件价格计算",
      acceptanceCriteria: ["目标测试通过", "完整回归通过", "恢复后回到缺陷基线"],
      selection,
    });
    const ledger = new EngineeringEvidenceLedger({ plan, repoMap });

    const failing = run(root, fixture.targetCommand);
    expect(failing.exitCode).not.toBe(0);
    ledger.recordVerification({
      kind: "reproduction",
      command: commandText(fixture.targetCommand),
      exitCode: failing.exitCode,
      durationMs: failing.durationMs,
    });

    const checkpoints = new CheckpointManager({
      cwd: root,
      rootDir: path.join(root, ".coremind", "checkpoints"),
      runId: `kernel-${fixture.language}`,
    });
    const checkpoint = await checkpoints.capture("write", { path: fixture.source });
    expect(checkpoint?.reversible).toBe(true);
    writeFileSync(path.join(root, fixture.source), fixture.repair, "utf8");
    const diff = await inspectCheckpoint(checkpoint as NonNullable<typeof checkpoint>, root);
    expect(diff.changed).toBe(true);
    expect(diff.unifiedDiff?.replaceAll("\\", "/")).toContain(fixture.source);
    await checkpoints.markApplied(checkpoint?.checkpointId ?? "");

    ledger.recordToolCall("write");
    ledger.recordChange({
      path: fixture.source,
      reason: "修正跨文件税率常量",
      checkpointId: checkpoint?.checkpointId ?? "",
      diff: diff.unifiedDiff ?? "",
    });
    const target = run(root, fixture.targetCommand);
    const regression = run(root, fixture.regressionCommand);
    ledger.recordVerification({
      kind: "target-test",
      command: commandText(fixture.targetCommand),
      exitCode: target.exitCode,
      durationMs: target.durationMs,
    });
    ledger.recordVerification({
      kind: "regression-test",
      command: commandText(fixture.regressionCommand),
      exitCode: regression.exitCode,
      durationMs: regression.durationMs,
    });
    ledger.markDiffReviewed();

    expect(ledger.finalize({ claimTestsPassed: true, outcome: "succeeded" })).toMatchObject({
      testsPassed: true,
      changedFiles: [fixture.source],
    });

    await restoreCheckpoint(checkpoint as NonNullable<typeof checkpoint>, root);
    expect(run(root, fixture.targetCommand).exitCode).not.toBe(0);
  });

  it("错误命令、审批拒绝和中止都不能伪装成成功", async () => {
    const root = createFixture(fixture.language);
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {
      language: fixture.language,
      testCommand: commandText(fixture.regressionCommand),
    });
    const ledger = new EngineeringEvidenceLedger({
      plan: createEngineeringTaskPlan({
        task: "验证失败控制面",
        acceptanceCriteria: ["失败保持失败"],
        selection,
      }),
      repoMap: buildRepositoryMap(inspection, selection),
    });
    const wrong = run(root, { command: "__coremind_missing_command__", args: [] });
    ledger.recordVerification({
      kind: "target-test",
      command: "__coremind_missing_command__",
      exitCode: wrong.exitCode,
      durationMs: wrong.durationMs,
    });
    ledger.recordControlEvent({ type: "approval-denied", detail: "用户拒绝写入" });
    ledger.recordControlEvent({ type: "aborted", detail: "执行已中止；可由通用 Session 恢复" });

    expect(() => ledger.finalize({ claimTestsPassed: true, outcome: "succeeded" })).toThrow();
    expect(ledger.finalize({ claimTestsPassed: false, outcome: "aborted" })).toMatchObject({
      outcome: "aborted",
      testsPassed: false,
    });
  });
});

function createFixture(language: Fixture["language"]): string {
  const root = mkdtempSync(path.join(tmpdir(), `coremind-kernel-${language}-`));
  if (language === "typescript") {
    write(
      root,
      "package.json",
      JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
    );
    write(root, "package-lock.json", "{}\n");
    write(root, "tsconfig.json", "{}\n");
    write(root, "src/rate.ts", "export const RATE = 0.1;\n");
    write(
      root,
      "src/price.ts",
      'import { RATE } from "./rate.ts";\nexport const price = (base) => base + base * RATE;\n',
    );
    write(
      root,
      "tests/price.test.ts",
      'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { price } from "../src/price.ts";\ntest("cross-file price", () => assert.equal(price(100), 120));\n',
    );
  } else {
    write(root, "pyproject.toml", "[project]\nname='coremind-kernel-fixture'\n");
    write(root, "src/__init__.py", "");
    write(root, "src/rate.py", "RATE = 0.1\n");
    write(
      root,
      "src/price.py",
      "from .rate import RATE\n\ndef price(base):\n    return base + base * RATE\n",
    );
    write(root, "tests/__init__.py", "");
    write(
      root,
      "tests/test_price.py",
      "import unittest\nfrom src.price import price\n\nclass PriceTest(unittest.TestCase):\n    def test_cross_file_price(self):\n        self.assertEqual(price(100), 120)\n",
    );
  }
  return root;
}

function write(root: string, relative: string, content: string): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

function run(
  cwd: string,
  request: Fixture["targetCommand"],
): { exitCode: number | null; durationMs: number } {
  const startedAt = Date.now();
  const result = spawnSync(request.command, request.args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 30_000,
  });
  return { exitCode: result.status, durationMs: Date.now() - startedAt };
}

function commandText(request: Fixture["targetCommand"]): string {
  return [request.command, ...request.args].join(" ");
}
