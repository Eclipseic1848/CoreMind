import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CoreMindConfig } from "coremind-config";
import { scaffoldProjectGuidance } from "coremind-templates";
import { describe, expect, it } from "vitest";
import { checkProject } from "./project-check.js";

const baseConfig: CoreMindConfig = {
  schemaVersion: 2,
  name: "quality-check",
  agents: { main: { systemPrompt: "测试助手" } },
  runtime: {},
  permissions: { mode: "ask", workspaceOnly: true, network: "ask" },
  quality: { profile: "standard", allowOverride: true },
};

describe("checkProject", () => {
  it("standard 项目材料齐全且无明文密钥时通过", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-pass-"));
    await scaffoldProjectGuidance({
      target: projectDir,
      projectName: "quality-check",
      language: "typescript",
    });

    const report = await checkProject({ config: baseConfig, projectDir });

    expect(report.passed).toBe(true);
    expect(report.findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("明文 API key 返回统一的不可覆盖配置错误", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-secret-"));
    const report = await checkProject({
      config: {
        ...baseConfig,
        provider: {
          id: "gateway",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "m1",
          apiKey: "secret",
        },
      },
      projectDir,
      overrideReason: "我接受风险",
    });

    expect(report.passed).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "invalid_config", overridable: false }),
    );
  });

  it("非安全材料缺失可按配置记录原因后覆盖", async () => {
    const projectDir = mkdtempSync(path.join(tmpdir(), "coremind-check-override-"));
    const report = await checkProject({
      config: baseConfig,
      projectDir,
      overrideReason: "临时原型，评审后补齐",
    });

    expect(report.passed).toBe(true);
    expect(report.overrideRecord?.reason).toContain("临时原型");
    expect(report.overrideRecord?.auditFile).toBe(
      path.join(projectDir, ".coremind", "quality-overrides.jsonl"),
    );
    expect(existsSync(report.overrideRecord!.auditFile)).toBe(true);
    expect(readFileSync(report.overrideRecord!.auditFile, "utf8")).toContain("临时原型");
  });
});
