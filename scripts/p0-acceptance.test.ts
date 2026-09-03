import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createP0AcceptanceReport,
  createWorkflowEvidence,
  inspectOfflineSeams,
  inspectReleaseManifest,
  loadEvidenceFiles,
  P0_CHECKS,
  P0_EXECUTION_PLAN,
  parseP0Arguments,
  validateStableSourceIdentity,
} from "./p0-acceptance.mjs";

const LIVE_PROVIDER_CHECKS = [
  "parent-model-call",
  "delegation-tool",
  "child-model-call",
  "child-tool-call",
  "structured-result",
  "cancel-convergence",
];

describe("P0 顶层发布验收", () => {
  it("证据提交与目标提交不一致时失败关闭", () => {
    const report = createP0AcceptanceReport({
      stage: "engineering",
      targetVersion: "0.7.0",
      commit: "a".repeat(40),
      runtimeDigest: `sha256:${"b".repeat(64)}`,
      artifacts: artifactSummary(),
      platform: "win32",
      generatedAt: "2026-08-29T16:00:00.000Z",
      suiteResults: {
        engineering: true,
        rc: true,
        entryEquivalence: true,
        runtimeWorkerFaults: true,
        version: true,
      },
      evidence: [
        {
          checkId: "P0-12",
          status: "passed",
          evidenceLevel: "offline",
          version: "0.7.0",
          commit: "d".repeat(40),
          runtimeDigest: `sha256:${"b".repeat(64)}`,
          platform: "win32",
          generatedAt: "2026-08-29T15:55:00.000Z",
          ref: ".scratch/rc-acceptance-win32.json",
        },
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === "P0-12")).toMatchObject({
      status: "failed",
    });
    expect(report.blockers.join("\n")).toContain("P0-12 证据提交不一致");
  });

  it("P0-01 到 P0-22 无缺号且 candidate 不接受跨级证据替代", () => {
    expect(P0_CHECKS.map((check) => check.id)).toEqual(
      Array.from({ length: 22 }, (_, index) => `P0-${String(index + 1).padStart(2, "0")}`),
    );

    const report = createP0AcceptanceReport({
      ...baseInput("candidate"),
      evidence: [
        evidence("P0-17", "repository-policy"),
        evidence("P0-19", "dual-platform", { platform: "win32" }),
        evidence("P0-19", "candidate-package", { platform: "win32", channel: "npm" }),
        evidence("P0-20", "candidate-package", { platform: "linux", channel: "pypi" }),
      ],
    });

    expect(report.passed).toBe(false);
    expect(report.blockers.join("\n")).toContain("P0-19 缺少 linux 双平台证据");
    expect(report.blockers.join("\n")).toContain("P0-19 缺少 win32/pypi 候选包证据");
    expect(report.blockers.join("\n")).toContain("P0-20 缺少 live-provider 或维护者网络豁免证据");
  });

  it("完整 candidate 证据通过但不会冒充发布和公开回装", () => {
    const report = createP0AcceptanceReport({
      ...baseInput("candidate"),
      evidence: [
        evidence("P0-17", "repository-policy"),
        ...["win32", "linux"].flatMap((platform) => [
          evidence("P0-19", "dual-platform", { platform }),
          evidence("P0-19", "candidate-package", { platform, channel: "npm" }),
          evidence("P0-19", "candidate-package", { platform, channel: "pypi" }),
        ]),
        evidence("P0-20", "live-provider", { platform: "linux" }),
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.id === "P0-20")?.status).toBe("passed");
    expect(report.checks.find((check) => check.id === "P0-21")?.status).toBe("not_required");
    expect(report.checks.find((check) => check.id === "P0-22")?.status).toBe("not_required");
    expect(report.artifacts.items.map((item) => item.sha256)).toEqual([
      "c".repeat(64),
      "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
      "d".repeat(64),
    ]);
  });

  it("0.7.0 只接受维护者已记录的一次性 Provider 网络豁免", () => {
    const report = createP0AcceptanceReport({
      ...baseInput("candidate"),
      evidence: [
        evidence("P0-17", "repository-policy"),
        ...["win32", "linux"].flatMap((platform) => [
          evidence("P0-19", "dual-platform", { platform }),
          evidence("P0-19", "candidate-package", { platform, channel: "npm" }),
          evidence("P0-19", "candidate-package", { platform, channel: "pypi" }),
        ]),
        evidence("P0-20", "provider-network-waiver", {
          status: "waived",
          decision: "provider-network-timeout-waived",
          strictRunId: 33582995518,
          strictCommit: "8a3fa98b09d3fdfd8fe92ae864bea213f34f17e3",
          failedJobId: 100134811632,
          candidateRuntimePackageSha256:
            "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
          decisionRef:
            "https://github.com/Eclipseic1848/CoreMind/issues/113#issuecomment-5505065678",
        }),
      ],
    });

    expect(report.passed).toBe(true);
    expect(report.checks.find((check) => check.id === "P0-20")).toMatchObject({
      status: "passed",
      evidenceLevels: expect.arrayContaining(["provider-network-waiver"]),
    });
  });

  it("所有证据绑定 Runtime 摘要且 live-provider 覆盖完整父子调用链", () => {
    const sharedEvidence = [
      evidence("P0-17", "repository-policy"),
      ...["win32", "linux"].flatMap((platform) => [
        evidence("P0-19", "dual-platform", { platform }),
        evidence("P0-19", "candidate-package", { platform, channel: "npm" }),
        evidence("P0-19", "candidate-package", { platform, channel: "pypi" }),
      ]),
    ];
    const missingRuntime = createP0AcceptanceReport({
      ...baseInput("candidate"),
      evidence: [
        evidence("P0-17", "repository-policy", { runtimeDigest: undefined }),
        ...sharedEvidence.slice(1),
        evidence("P0-20", "live-provider"),
      ],
    });

    expect(missingRuntime.passed).toBe(false);
    expect(missingRuntime.blockers).toContain("P0-17 Runtime 摘要不一致");

    for (const missingCheck of LIVE_PROVIDER_CHECKS) {
      const report = createP0AcceptanceReport({
        ...baseInput("candidate"),
        evidence: [
          ...sharedEvidence,
          evidence("P0-20", "live-provider", {
            checks: LIVE_PROVIDER_CHECKS.filter((check) => check !== missingCheck),
          }),
        ],
      });
      expect(report.passed).toBe(false);
      expect(report.blockers).toContain(`P0-20 live-provider 缺少检查：${missingCheck}`);
    }
  });

  it("非法目标、缺失 manifest 与本地引用失败关闭", () => {
    const unknownCommit = createP0AcceptanceReport({
      ...baseInput("engineering"),
      commit: "unknown",
      evidence: [],
    });
    const wrongVersion = createP0AcceptanceReport({
      ...baseInput("engineering"),
      targetVersion: "0.8.0",
      evidence: [],
    });
    const missingManifest = createP0AcceptanceReport({
      ...baseInput("candidate"),
      artifacts: null,
      evidence: [],
    });
    const missingLocalRef = createP0AcceptanceReport({
      ...baseInput("engineering"),
      suiteResults: {
        ...baseInput("engineering").suiteResults,
        localRefs: { ...baseInput("engineering").suiteResults.localRefs, "P0-12": false },
      },
      evidence: [],
    });
    const missingTty = createP0AcceptanceReport({
      ...baseInput("candidate"),
      suiteResults: { ...baseInput("candidate").suiteResults, tty: false },
      evidence: [],
    });
    const dirtySource = createP0AcceptanceReport({
      ...baseInput("engineering"),
      sourceClean: false,
      evidence: [],
    });

    expect(unknownCommit.passed).toBe(false);
    expect(unknownCommit.blockers).toContain("目标提交必须是 40 位 Git SHA");
    expect(wrongVersion.passed).toBe(false);
    expect(wrongVersion.blockers).toContain("P0 目标版本必须为 0.7.0");
    expect(missingManifest.passed).toBe(false);
    expect(missingManifest.blockers).toContain("candidate 阶段缺少候选产物 manifest");
    expect(missingLocalRef.passed).toBe(false);
    expect(missingLocalRef.blockers.join("\n")).toContain("P0-12 本地证据引用不存在");
    expect(missingTty.blockers.join("\n")).toContain("P0-19 双平台真实 TTY seam 未通过");
    expect(dirtySource.blockers).toContain("验收源代码必须是干净的 Git 提交");
  });

  it("复用 release manifest 并复算实际产物 SHA-256", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "coremind-p0-artifacts-"));
    try {
      const npmContent = Buffer.from("npm artifact", "utf8");
      const pythonContent = Buffer.from("python artifact", "utf8");
      await mkdir(path.join(artifactRoot, "npm"));
      await mkdir(path.join(artifactRoot, "python"));
      await writeFile(path.join(artifactRoot, "npm", "coremind-cli.tgz"), npmContent);
      await writeFile(path.join(artifactRoot, "python", "coremind_ai.whl"), pythonContent);
      const raw = `${JSON.stringify({
        schemaVersion: 1,
        version: "0.7.0",
        commit: "a".repeat(40),
        artifacts: [
          artifact("npm/coremind-cli.tgz", "npm", "coremind-cli", npmContent),
          artifact("python/coremind_ai.whl", "python", "coremind-ai", pythonContent),
        ],
      })}\n`;
      const expected = {
        targetVersion: "0.7.0",
        commit: "a".repeat(40),
        ref: "release-artifacts/release-manifest.json",
        artifactRoot,
      };

      const inspected = await inspectReleaseManifest(raw, expected);
      expect(inspected.blockers).toEqual([]);
      expect(inspected.summary.items).toHaveLength(2);
      expect(inspected.summary.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

      await writeFile(path.join(artifactRoot, "npm", "coremind-cli.tgz"), "tampered", "utf8");
      const tampered = await inspectReleaseManifest(raw, expected);
      expect(tampered.blockers.join("\n")).toContain("实际 SHA-256 不一致");

      const escaped = await inspectReleaseManifest(
        raw.replace("npm/coremind", "../coremind"),
        expected,
      );
      expect(escaped.blockers.join("\n")).toContain("必须位于候选产物目录内");

      const duplicate = await inspectReleaseManifest(
        raw.replace("python/coremind_ai.whl", "npm/coremind-cli.tgz"),
        expected,
      );
      expect(duplicate.blockers.join("\n")).toContain("path 重复");
      expect(duplicate.blockers.join("\n")).toContain("python 产物必须是 .whl");

      const sharedDirectory = path.join(artifactRoot, "shared");
      const firstAlias = path.join(artifactRoot, "npm-alias-a");
      const secondAlias = path.join(artifactRoot, "npm-alias-b");
      const sharedContent = Buffer.from("shared npm artifact", "utf8");
      await mkdir(sharedDirectory);
      await writeFile(path.join(sharedDirectory, "coremind-cli.tgz"), sharedContent);
      await symlink(sharedDirectory, firstAlias, process.platform === "win32" ? "junction" : "dir");
      await symlink(
        sharedDirectory,
        secondAlias,
        process.platform === "win32" ? "junction" : "dir",
      );
      const aliased = await inspectReleaseManifest(
        `${JSON.stringify({
          schemaVersion: 1,
          version: "0.7.0",
          commit: "a".repeat(40),
          artifacts: [
            artifact("npm-alias-a/coremind-cli.tgz", "npm", "coremind-cli", sharedContent),
            artifact("npm-alias-b/coremind-cli.tgz", "npm", "coremind-cli-copy", sharedContent),
            artifact("python/coremind_ai.whl", "python", "coremind-ai", pythonContent),
          ],
        })}\n`,
        expected,
      );
      expect(aliased.blockers.join("\n")).toContain("实际路径重复");
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("验收期间 HEAD 漂移时失败关闭", () => {
    expect(
      validateStableSourceIdentity(
        { commit: "a".repeat(40), clean: true },
        { commit: "b".repeat(40), clean: true },
      ),
    ).toContain("验收期间 Git HEAD 发生变化");
  });

  it("复用完整工程与候选门并确认四入口与故障 seam 存在", async () => {
    expect(P0_EXECUTION_PLAN.engineering.map((item) => item.name)).toEqual([
      "quality",
      "security",
      "build",
      "workspaceLease",
      "dependencies",
      "docs",
      "providerMatrix",
      "providerMatrixClean",
      "engineeringTests",
      "pythonWorker",
      "pythonSdk",
      "pythonExample",
    ]);
    expect(P0_EXECUTION_PLAN.candidate.map((item) => item.name)).toEqual([
      ...P0_EXECUTION_PLAN.engineering.map((item) => item.name),
      "baseline",
      "stability",
      "coverage",
      "tty",
      "sourcePackage",
      "rc",
    ]);
    expect(
      P0_EXECUTION_PLAN.engineering.find((item) => item.name === "engineeringTests")?.args,
    ).toContain("--maxWorkers=1");
    expect(P0_EXECUTION_PLAN.candidate.at(-1)?.args).toContain("--defer-provider-certification");
    expect(P0_EXECUTION_PLAN.release.at(-1)?.args).not.toContain("--defer-provider-certification");
    expect(P0_EXECUTION_PLAN.release.at(-1)?.args).toContain("--allow-provider-network-waiver");
    const seams = await inspectOfflineSeams(process.cwd());
    expect(seams).toMatchObject({
      entryEquivalence: true,
      runtimeWorkerFaults: true,
    });
    expect(Object.values(seams.localRefs).every(Boolean)).toBe(true);
  });

  it("把已验证 Workflow 事实转换为候选、发布和回装证据", () => {
    const common = {
      version: "0.7.0",
      commit: "a".repeat(40),
      runtimeDigest: `sha256:${"b".repeat(64)}`,
      artifactManifestDigest: `sha256:${"e".repeat(64)}`,
      runtimePackageSha256: "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
      candidateRunId: "123",
      policySnapshotSha256: "9".repeat(64),
      providerEvidenceMode: "provider-network-waiver",
      repositoryRulesetId: "21807589",
      workflowRunId: "456",
      releaseTag: "v0.7.0",
    };

    const candidate = createWorkflowEvidence({ ...common, stage: "candidate" });
    expect(candidate).toHaveLength(8);
    expect(candidate.find((item) => item.checkId === "P0-20")).toMatchObject({
      status: "waived",
      strictRunId: 33582995518,
      candidateRuntimePackageSha256:
        "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
    });
    const finalRuntimePackageSha256 =
      "6bea6efd0132978300fcd3d11094ce72ff9b70484f1b671e039861f3ea366b18";
    const release = createWorkflowEvidence({
      ...common,
      stage: "release",
      runtimePackageSha256: finalRuntimePackageSha256,
    });
    expect(release.filter((item) => item.checkId === "P0-21")).toHaveLength(4);
    expect(release.find((item) => item.checkId === "P0-20")).toMatchObject({
      candidateRuntimePackageSha256:
        "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
      finalRuntimePackageSha256,
      finalDecisionRef:
        "https://github.com/Eclipseic1848/CoreMind/issues/113#issuecomment-5523505893",
    });
    const releaseReport = createP0AcceptanceReport({
      ...baseInput("release"),
      artifacts: artifactSummary(finalRuntimePackageSha256),
      evidence: release.map((item) => ({
        ...item,
        sourceRef: "workflow.json",
        sourceDigest: `sha256:${"f".repeat(64)}`,
      })),
    });
    expect(releaseReport.passed).toBe(true);
    const invalidFinalDigest = createP0AcceptanceReport({
      ...baseInput("release"),
      artifacts: artifactSummary(finalRuntimePackageSha256),
      evidence: release.map((item) => ({
        ...item,
        ...(item.checkId === "P0-20" ? { finalRuntimePackageSha256: "0".repeat(64) } : {}),
        sourceRef: "workflow.json",
        sourceDigest: `sha256:${"f".repeat(64)}`,
      })),
    });
    expect(invalidFinalDigest.blockers).toContain("P0-20 网络豁免最终 Runtime 包摘要无效");
    const postRelease = createWorkflowEvidence({
      ...common,
      stage: "post-release",
      runtimePackageSha256: finalRuntimePackageSha256,
    });
    expect(postRelease.filter((item) => item.checkId === "P0-22")).toHaveLength(2);
    expect(() => createWorkflowEvidence({ ...common, repositoryRulesetId: "" })).toThrow(
      "GitHub main ruleset 未经过当前发布 Workflow 验证",
    );
    expect(() => createWorkflowEvidence({ ...common, policySnapshotSha256: "" })).toThrow(
      "main ruleset 只读快照摘要无效",
    );

    const invalidWaiver = createP0AcceptanceReport({
      ...baseInput("candidate"),
      evidence: createWorkflowEvidence({
        ...common,
        stage: "candidate",
        runtimePackageSha256: "0".repeat(64),
      }).map((item) => ({
        ...item,
        ...(item.checkId === "P0-20" ? { candidateRuntimePackageSha256: "0".repeat(64) } : {}),
        sourceRef: "workflow.json",
        sourceDigest: `sha256:${"f".repeat(64)}`,
      })),
    });
    expect(invalidWaiver.blockers).toContain("P0-20 网络豁免候选 Runtime 包摘要无效");
  });

  it("把外部证据绑定到实际输入文件及其 SHA-256", async () => {
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "coremind-p0-evidence-"));
    try {
      await writeFile(
        path.join(evidenceRoot, "evidence.json"),
        JSON.stringify({ ...evidence("P0-17", "repository-policy"), sourceRef: "fake.json" }),
        "utf8",
      );

      const loaded = await loadEvidenceFiles(evidenceRoot, ["evidence.json"]);
      expect(loaded.blockers).toEqual([]);
      expect(loaded.evidence[0]).toMatchObject({
        sourceRef: "evidence.json",
        sourceDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  it("根命令固定候选默认值并接受可重复证据参数", () => {
    expect(
      parseP0Arguments([
        "--stage",
        "release",
        "--artifact-manifest",
        "artifacts/release-manifest.json",
        "--evidence",
        "windows.json",
        "--evidence",
        "linux.json",
      ]),
    ).toEqual({
      stage: "release",
      targetVersion: "0.7.0",
      artifactManifest: "artifacts/release-manifest.json",
      evidenceFiles: ["windows.json", "linux.json"],
      verifiedWorkflowRun: null,
    });
    expect(
      parseP0Arguments([
        "--stage",
        "candidate",
        "--artifact-manifest",
        "artifacts/release-manifest.json",
        "--verified-workflow-run",
        "123",
      ]).verifiedWorkflowRun,
    ).toBe("123");
    expect(() => parseP0Arguments(["--stage", "unknown"])).toThrow("未知 P0 验收阶段");
    expect(() => parseP0Arguments([])).toThrow("candidate 阶段必须提供 --artifact-manifest");
    expect(() => parseP0Arguments(["--target-version", "0.8.0"])).toThrow("未知参数");
  });
});

function baseInput(stage: "engineering" | "candidate" | "release" | "post-release") {
  return {
    stage,
    targetVersion: "0.7.0",
    commit: "a".repeat(40),
    runtimeDigest: `sha256:${"b".repeat(64)}`,
    artifacts: artifactSummary(),
    platform: "win32",
    generatedAt: "2026-08-29T16:00:00.000Z",
    sourceClean: true,
    suiteResults: {
      engineering: true,
      rc: true,
      entryEquivalence: true,
      runtimeWorkerFaults: true,
      tty: true,
      version: true,
      localRefs: Object.fromEntries(P0_CHECKS.map((check) => [check.id, true])),
    },
  };
}

function artifact(file: string, kind: string, name: string, content: Buffer) {
  return {
    path: file,
    kind,
    name,
    version: "0.7.0",
    size: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function evidence(checkId: string, evidenceLevel: string, overrides: Record<string, unknown> = {}) {
  return {
    checkId,
    status: "passed",
    evidenceLevel,
    version: "0.7.0",
    commit: "a".repeat(40),
    runtimeDigest: `sha256:${"b".repeat(64)}`,
    artifactManifestDigest: `sha256:${"e".repeat(64)}`,
    platform: "win32",
    generatedAt: "2026-08-29T15:55:00.000Z",
    ref: `evidence/${checkId}-${evidenceLevel}.json`,
    sourceRef: `evidence/${checkId}-${evidenceLevel}.json`,
    sourceDigest: `sha256:${"f".repeat(64)}`,
    ...(evidenceLevel === "live-provider" ? { checks: LIVE_PROVIDER_CHECKS } : {}),
    ...(evidenceLevel === "repository-policy"
      ? {
          policySnapshotRef: "docs/release/evidence/v0.7.0-main-ruleset.json",
          policySnapshotSha256: "9".repeat(64),
        }
      : {}),
    ...overrides,
  };
}

function artifactSummary(
  runtimePackageSha256 = "16fd6fea9ea0e316cd14d9907ee22454ab0d2e1e3e4dca629151733f1d2f58ea",
) {
  return {
    ref: "artifacts/release-manifest.json",
    manifestDigest: `sha256:${"e".repeat(64)}`,
    items: [
      {
        path: "npm/coremind-cli.tgz",
        kind: "npm",
        name: "coremind-cli",
        version: "0.7.0",
        size: 100,
        sha256: "c".repeat(64),
      },
      {
        path: "npm/coremind-runtime.tgz",
        kind: "npm",
        name: "coremind-runtime",
        version: "0.7.0",
        size: 300,
        sha256: runtimePackageSha256,
      },
      {
        path: "python/coremind_ai.whl",
        kind: "python",
        name: "coremind-ai",
        version: "0.7.0",
        size: 200,
        sha256: "d".repeat(64),
      },
    ],
  };
}
