import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateRcAcceptance,
  RC_CASES,
  RC_SUITES,
  TTY_CHECKS,
  TTY_EVIDENCE_RELATIVE_DIRECTORY,
  validateTtyEvidence,
  verifyRcCaseEvidence,
} from "./rc-acceptance.mjs";

describe("Release Candidate 验收矩阵", () => {
  it("P01 到 P20 无缺号且一期四入口都在合同中", () => {
    expect(RC_CASES.map((item) => item.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`),
    );
    const entries = new Set(RC_CASES.flatMap((item) => item.entries));
    expect(entries).toEqual(
      new Set(["tui", "headless-cli", "typescript-sdk", "python-sdk", "artifact"]),
    );
    expect(RC_CASES.filter((item) => !item.manual).every((item) => item.evidence.length > 0)).toBe(
      true,
    );
  });

  it("自动套件和逐 Case 证据全部成功时 P01-P19 通过，P20 仍等待真实伪终端", () => {
    const suiteResults = Object.fromEntries(
      ["node", "python", "metadata", "artifacts"].map((name) => [name, true]),
    );
    const report = evaluateRcAcceptance({
      suiteResults,
      evidenceResults: allCaseEvidence(true),
      manualEvidence: [],
    });

    expect(report.automatedReady).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.cases.find((item) => item.id === "P20")?.status).toBe("pending_manual");
  });

  it("双平台真实伪终端证据齐全后才能整体通过", () => {
    const suiteResults = { node: true, python: true, metadata: true, artifacts: true };
    const report = evaluateRcAcceptance({
      suiteResults,
      evidenceResults: allCaseEvidence(true),
      manualEvidence: [
        { platform: "windows", passed: true },
        { platform: "linux", passed: true },
      ],
    });

    expect(report.ready).toBe(true);
    expect(report.cases.every((item) => item.status === "passed")).toBe(true);
  });

  it("任何 Case 缺少可追溯测试锚点时不能被整套测试结果掩盖", () => {
    const suiteResults = { node: true, python: true, metadata: true, artifacts: true };
    const evidenceResults = allCaseEvidence(true);
    evidenceResults.P17 = false;

    const report = evaluateRcAcceptance({ suiteResults, evidenceResults, manualEvidence: [] });

    expect(report.automatedReady).toBe(false);
    expect(report.cases.find((item) => item.id === "P17")?.status).toBe("failed");
  });

  it("仓库中的所有逐 Case 测试锚点均存在", async () => {
    const result = await verifyRcCaseEvidence(process.cwd());

    expect(result.blockers).toEqual([]);
    expect(Object.values(result.results).every(Boolean)).toBe(true);
  });

  it("P18 会执行内容、publint、类型解析与干净安装门禁", () => {
    const artifactSuite = RC_SUITES.find((suite) => suite.name === "artifacts");
    const commands = artifactSuite?.commands.map(([, args]) => args.join(" ")) ?? [];

    expect(commands).toEqual(
      expect.arrayContaining(["run release:check-npm", "run release:test-npm"]),
    );
  });

  it("真实伪终端证据必须绑定候选版本、提交和全部交互检查", () => {
    const evidence = {
      schemaVersion: 1,
      platform: "windows",
      version: "0.2.0-rc.1",
      commit: "abc123",
      testedAt: "2026-08-09T15:00:00.000Z",
      terminal: "Windows Terminal / PowerShell 7",
      passed: true,
      evidenceLevel: "automated-real-tty",
      checks: Object.fromEntries(TTY_CHECKS.map((check) => [check, true])),
    };

    expect(
      validateTtyEvidence(evidence, {
        platform: "windows",
        version: "0.2.0-rc.1",
        commit: "abc123",
      }),
    ).toEqual([]);
  });

  it("缺少状态检查或绑定到其他提交的伪终端证据不能通过", () => {
    const evidence = {
      schemaVersion: 1,
      platform: "linux",
      version: "0.2.0-rc.1",
      commit: "old",
      testedAt: "2026-08-09T15:00:00.000Z",
      terminal: "browser terminal",
      passed: true,
      evidenceLevel: "automated-real-tty",
      checks: Object.fromEntries(TTY_CHECKS.map((check) => [check, check !== "abort"])),
    };

    const blockers = validateTtyEvidence(evidence, {
      platform: "linux",
      version: "0.2.0-rc.1",
      commit: "current",
    });

    expect(blockers.join("\n")).toContain("commit");
    expect(blockers.join("\n")).toContain("abort");
  });

  it("真实伪终端证据保存在不改变候选提交的忽略目录", () => {
    expect(TTY_EVIDENCE_RELATIVE_DIRECTORY.replaceAll("\\", "/")).toBe(".scratch/rc-evidence");
  });

  it("双平台 TTY 模板版本与根版本保持一致", async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    for (const platform of ["windows", "linux"]) {
      const template = JSON.parse(
        await readFile(
          path.join(root, "docs", "release", "evidence", `rc-tty-${platform}.example.json`),
          "utf8",
        ),
      );
      expect(template.version).toBe(manifest.version);
    }
  });
});

function allCaseEvidence(value: boolean): Record<string, boolean> {
  return Object.fromEntries(
    RC_CASES.filter((item) => !item.manual).map((item) => [item.id, value]),
  );
}
