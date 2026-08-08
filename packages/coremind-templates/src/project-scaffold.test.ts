import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectLanguage, scaffoldProjectGuidance } from "./project-scaffold.js";

describe("项目接入与指导材料脚手架", () => {
  it("根据已有工程证据自动识别 TypeScript、JavaScript 或 Python", async () => {
    const typescript = mkdtempSync(path.join(tmpdir(), "coremind-detect-ts-"));
    writeFileSync(path.join(typescript, "package.json"), '{"name":"demo"}', "utf8");
    writeFileSync(path.join(typescript, "tsconfig.json"), "{}", "utf8");
    const javascript = mkdtempSync(path.join(tmpdir(), "coremind-detect-js-"));
    writeFileSync(path.join(javascript, "package.json"), '{"name":"demo"}', "utf8");
    const python = mkdtempSync(path.join(tmpdir(), "coremind-detect-py-"));
    writeFileSync(path.join(python, "pyproject.toml"), "[project]\nname='demo'", "utf8");

    await expect(detectProjectLanguage(typescript)).resolves.toBe("typescript");
    await expect(detectProjectLanguage(javascript)).resolves.toBe("javascript");
    await expect(detectProjectLanguage(python)).resolves.toBe("python");
  });

  it("生成配置开发所需的 SOP、Skill、测试、评测和决策骨架", async () => {
    const target = mkdtempSync(path.join(tmpdir(), "coremind-scaffold-"));

    const created = await scaffoldProjectGuidance({
      target,
      projectName: "order-agent",
      language: "typescript",
    });

    for (const relative of [
      "src/tools/example.ts",
      "tests/README.md",
      "evals/scenarios.yaml",
      "docs/requirements.zh-CN.md",
      "docs/requirements.en.md",
      "docs/development-sop.zh-CN.md",
      "docs/development-sop.en.md",
      "docs/acceptance-checklist.zh-CN.md",
      "docs/acceptance-checklist.en.md",
      "skills/project-agent/SKILL.md",
      ".coremind/decisions.md",
    ]) {
      expect(existsSync(path.join(target, relative)), relative).toBe(true);
      expect(created).toContain(relative);
    }
    expect(await readFile(path.join(target, "docs", "requirements.zh-CN.md"), "utf8")).toContain(
      "TODO（需业务负责人确认）",
    );
  });
});
