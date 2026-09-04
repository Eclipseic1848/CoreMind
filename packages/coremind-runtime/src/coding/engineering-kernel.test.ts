import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRepositoryMap,
  CODING_TOOL_CONTRACTS,
  CodingKernelError,
  createEngineeringKernelDefinition,
  createEngineeringTaskPlan,
  EngineeringEvidenceLedger,
  inspectCodingRepository,
  selectCodingEnvironment,
} from "./engineering-kernel.js";

function repository(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-coding-kernel-"));
}

function write(root: string, relative: string, content = ""): void {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
}

describe("inspectCodingRepository", () => {
  it("识别 TypeScript、npm 和真实 test script，但只给建议", async () => {
    const root = repository();
    write(
      root,
      "package.json",
      JSON.stringify({ scripts: { test: "node --test", build: "tsc -p tsconfig.json" } }),
    );
    write(root, "package-lock.json", "{}");
    write(root, "tsconfig.json", "{}");
    write(root, "src/index.ts", "export const value = 1;\n");
    write(root, "tests/index.test.ts", "");

    const inspection = await inspectCodingRepository(root);

    expect(inspection.recommendedLanguage).toBe("typescript");
    expect(inspection.languageCandidates[0]?.evidence).toContain("tsconfig.json");
    expect(inspection.packageManagers).toEqual(["npm"]);
    expect(inspection.testCommands).toContain("npm test");
    expect(inspection.requiresUserChoice).toBe(false);
    expect(inspection.selection).toBeUndefined();
  });

  it("JavaScript 工程不会被误判为 TypeScript", async () => {
    const root = repository();
    write(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(root, "src/index.js", "export const value = 1;\n");

    const inspection = await inspectCodingRepository(root);

    expect(inspection.recommendedLanguage).toBe("javascript");
  });

  it("识别 Python 与 unittest 回归命令", async () => {
    const root = repository();
    write(root, "pyproject.toml", "[project]\nname='demo'\n");
    write(root, "src/app.py", "VALUE = 1\n");
    write(root, "tests/test_app.py", "");

    const inspection = await inspectCodingRepository(root);

    expect(inspection.recommendedLanguage).toBe("python");
    expect(inspection.testCommands).toContain("python -m unittest discover -s tests");
  });

  it("从 Python 清单内容识别 pytest，而不是给出错误的 unittest 建议", async () => {
    const root = repository();
    write(root, "pyproject.toml", "[project]\nname='demo'\ndependencies=['pytest>=8']\n");
    write(root, "src/app.py", "VALUE = 1\n");
    write(root, "tests/test_app.py", "");

    const inspection = await inspectCodingRepository(root);

    expect(inspection.testCommands).toContain("python -m pytest");
    expect(inspection.testCommands).not.toContain("python -m unittest discover -s tests");
  });

  it("混合语言或多个包管理器时要求用户选择", async () => {
    const root = repository();
    write(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(root, "package-lock.json", "{}");
    write(root, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(root, "src/index.ts", "");
    write(root, "src/worker.py", "");

    const inspection = await inspectCodingRepository(root);

    expect(inspection.requiresUserChoice).toBe(true);
    await expect(selectCodingEnvironment(inspection, {})).rejects.toMatchObject({
      code: "coding_choice_required",
    });
    const selected = await selectCodingEnvironment(inspection, {
      language: "typescript",
      packageManager: "npm",
      testCommand: "npm test",
    });
    expect(selected).toMatchObject({ language: "typescript", packageManager: "npm" });
  });
});

describe("Engineering Kernel contracts", () => {
  it("构建 repo map、标准计划和受控 verify/repair Loop", async () => {
    const root = repository();
    write(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(root, "package-lock.json", "{}");
    write(root, "tsconfig.json", "{}");
    write(root, "src/service.ts", "");
    write(root, "src/helper.ts", "");
    write(root, "tests/service.test.ts", "");
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {});
    const repoMap = buildRepositoryMap(inspection, selection);
    const plan = createEngineeringTaskPlan({
      task: "修复跨文件折扣计算",
      acceptanceCriteria: ["目标测试通过", "完整回归通过"],
      selection,
    });
    const kernel = createEngineeringKernelDefinition({ selection });

    expect(repoMap.entries.filter((entry) => entry.kind === "source")).toHaveLength(2);
    expect(plan.phases.map((phase) => phase.id)).toEqual([
      "understand",
      "plan",
      "modify",
      "verify",
      "repair",
      "deliver",
    ]);
    expect(kernel.loop).toMatchObject({ maxIterations: 3, maxRepairs: 2, maxRepeatedAction: 2 });
    expect(kernel.loop.verify.mode !== "host" && kernel.loop.verify.evidence).toEqual({
      mode: "runtime",
      regressionCommand: "npm test",
      minSuccessfulTestCommands: 2,
      requireCheckpoint: true,
      requireDiffReview: true,
    });
    expect(kernel.requiredTools).toEqual(CODING_TOOL_CONTRACTS.map((tool) => tool.id));
    expect(kernel.excludedCapabilities).toContain("browser-automation");
  });

  it("变更集要求每个写入文件关联写前 checkpoint", async () => {
    const root = repository();
    write(root, "package.json", "{}");
    write(root, "src/a.js", "");
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {});
    const plan = createEngineeringTaskPlan({
      task: "修复 a.js",
      acceptanceCriteria: ["node --test 通过"],
      selection,
    });
    const ledger = new EngineeringEvidenceLedger({
      plan,
      repoMap: buildRepositoryMap(inspection, selection),
    });

    expect(() =>
      ledger.recordChange({
        path: "src/a.js",
        reason: "修复边界条件",
        checkpointId: "",
        diff: "--- a/src/a.js\n+++ b/src/a.js",
      }),
    ).toThrow(CodingKernelError);
  });

  it("只有目标与回归命令真实成功且已审查 Diff 时才允许声明测试通过", async () => {
    const root = repository();
    write(root, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    write(root, "src/a.js", "");
    write(root, "tests/a.test.js", "");
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {});
    const plan = createEngineeringTaskPlan({
      task: "修复 a.js",
      acceptanceCriteria: ["目标测试通过", "回归通过"],
      selection,
    });
    const ledger = new EngineeringEvidenceLedger({
      plan,
      repoMap: buildRepositoryMap(inspection, selection),
    });
    ledger.recordToolCall("read");
    ledger.recordToolCall("edit");
    ledger.recordChange({
      path: "src/a.js",
      reason: "修复边界条件",
      checkpointId: "checkpoint-1",
      diff: "--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@",
    });
    ledger.recordVerification({
      kind: "target-test",
      command: "node --test tests/a.test.js",
      exitCode: 0,
      durationMs: 20,
    });

    expect(() => ledger.finalize({ claimTestsPassed: true, outcome: "succeeded" })).toThrowError(
      expect.objectContaining({ code: "coding_verification_claim_mismatch" }),
    );

    ledger.recordVerification({
      kind: "regression-test",
      command: "npm test",
      exitCode: 0,
      durationMs: 50,
    });
    ledger.markDiffReviewed();
    const summary = ledger.finalize({ claimTestsPassed: true, outcome: "succeeded" });

    expect(summary.testsPassed).toBe(true);
    expect(summary.changedFiles).toEqual(["src/a.js"]);
    expect(summary.verification).toHaveLength(2);
    expect(summary.planToolConsistency.unplannedTools).toEqual([]);
  });

  it("失败命令、中止或审批拒绝不能形成成功交付", async () => {
    const root = repository();
    write(root, "pyproject.toml", "[project]\nname='demo'\n");
    write(root, "src/a.py", "");
    const inspection = await inspectCodingRepository(root);
    const selection = await selectCodingEnvironment(inspection, {});
    const plan = createEngineeringTaskPlan({
      task: "修复 a.py",
      acceptanceCriteria: ["回归通过"],
      selection,
    });
    const ledger = new EngineeringEvidenceLedger({
      plan,
      repoMap: buildRepositoryMap(inspection, selection),
    });
    ledger.recordVerification({
      kind: "regression-test",
      command: "python -m unittest discover -s tests",
      exitCode: 1,
      durationMs: 10,
    });
    ledger.recordControlEvent({ type: "approval-denied", detail: "write 被拒绝" });

    expect(() => ledger.finalize({ claimTestsPassed: false, outcome: "succeeded" })).toThrowError(
      expect.objectContaining({ code: "coding_delivery_not_verified" }),
    );
    expect(ledger.finalize({ claimTestsPassed: false, outcome: "paused" }).testsPassed).toBe(false);
  });
});
