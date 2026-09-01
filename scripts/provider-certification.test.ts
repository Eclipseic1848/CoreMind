import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertCertificationSucceeded,
  createCertificationEvidence,
  inspectCandidateManifest,
  upsertCertificationRecord,
  validateCertificationApproval,
  verifyCandidateArtifact,
} from "./provider-certification.mjs";

describe("Provider 认证批准边界", () => {
  it("五项批准不完整或候选身份不一致时在联网前失败", () => {
    const approved = {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: "0.5",
      maxDurationMinutes: "15",
      expectedVersion: "0.7.0",
      expectedCommit: "a".repeat(40),
      expectedRuntimeArtifactSha256: "b".repeat(64),
    };
    const actual = {
      version: "0.7.0",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
    };

    for (const key of ["provider", "model", "credentialEnv", "maxCostUsd", "maxDurationMinutes"]) {
      expect(() => validateCertificationApproval({ ...approved, [key]: "" }, actual)).toThrow(
        `认证批准边界不完整：${key}`,
      );
    }
    expect(() =>
      validateCertificationApproval({ ...approved, expectedCommit: "c".repeat(40) }, actual),
    ).toThrow("认证候选提交与批准值不一致");
    expect(validateCertificationApproval(approved, actual)).toMatchObject({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: 0.5,
      maxDurationMs: 900_000,
      maxRetries: 0,
    });
  });

  it("候选清单必须绑定批准提交、版本与 Runtime 包摘要", () => {
    const artifact = Buffer.from("candidate runtime artifact", "utf8");
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    const raw = `${JSON.stringify({
      schemaVersion: 1,
      version: "0.7.0",
      commit: "a".repeat(40),
      artifacts: [
        {
          kind: "npm",
          name: "coremind-runtime",
          version: "0.7.0",
          path: "coremind-runtime-0.7.0.tgz",
          sha256: artifactSha256,
        },
      ],
    })}\n`;

    expect(
      inspectCandidateManifest(raw, {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: artifactSha256,
      }),
    ).toMatchObject({
      candidateArtifactPath: "coremind-runtime-0.7.0.tgz",
      candidateArtifactSha256: artifactSha256,
      artifactManifestDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(() => verifyCandidateArtifact(artifact, artifactSha256)).not.toThrow();
    expect(() => verifyCandidateArtifact(Buffer.from("replaced"), artifactSha256)).toThrow(
      "候选 Runtime Artifact 实际摘要与清单不一致",
    );
    expect(() =>
      inspectCandidateManifest(raw, {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "c".repeat(64),
      }),
    ).toThrow("候选 Runtime Artifact 与批准值不一致");
    expect(() =>
      inspectCandidateManifest(raw.replace("coremind-runtime-0.7.0.tgz", "../runtime.tgz"), {
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: artifactSha256,
      }),
    ).toThrow("候选 Runtime Artifact 路径无效");
  });
});

describe("Provider 认证诊断", () => {
  it("失败时保留终态、错误码和上游诊断", () => {
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: {
            status: "failed",
            finishReason: "agent_failed",
            error: { code: "agent_failed", message: "403 AccessDenied.Unpurchased" },
          },
        },
        "流式场景",
      ),
    ).toThrow("流式场景失败：agent_failed / agent_failed / 403 AccessDenied.Unpurchased");
    expect(() =>
      assertCertificationSucceeded(
        {
          outcome: {
            status: "failed",
            finishReason: "agent_failed",
            error: { code: "agent_failed", message: "upstream leaked sk-cert-secret" },
          },
        },
        "父子场景",
        ["sk-cert-secret"],
      ),
    ).toThrow("父子场景失败：agent_failed / agent_failed / upstream leaked [REDACTED]");
  });

  it("只为包含版本且三轮会话通过的完整结果生成证据", () => {
    const evidence = createCertificationEvidence({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.2.0-rc.1",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-09T20:00:00.000Z",
      platform: "win32-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    });

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      version: "0.2.0-rc.1",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      details: { multiTurn: { passed: true, turns: 3 } },
      checks: expect.arrayContaining(["abort", "long-context", "cancel-convergence"]),
      secretsRecorded: false,
    });
  });

  it("拒绝缺少版本或不足三轮的认证证据", () => {
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "",
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(3),
      }),
    ).toThrow("缺少 CoreMind 版本");
    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "0.2.0-rc.1",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        testedAt: "2026-08-09T20:00:00.000Z",
        platform: "win32-x64",
        node: "v22.22.1",
        details: completeDetails(2),
      }),
    ).toThrow("至少需要三轮");
  });

  it("拒绝缺少完整父子产品链或取消收敛的证据", () => {
    const details = completeDetails(3);
    delete details.childRunCancel;

    expect(() =>
      createCertificationEvidence({
        provider: "alibaba-model-studio",
        model: "qwen-plus",
        version: "0.7.0",
        commit: "a".repeat(40),
        runtimeArtifactSha256: "b".repeat(64),
        testedAt: "2026-08-31T20:00:00.000Z",
        platform: "linux-x64",
        node: "v22.22.1",
        details,
        ...completeBoundEvidence(),
      }),
    ).toThrow("Provider 认证检查未通过：childRunCancel");
  });

  it("拒绝缺少候选制品、零重试用量或超出人工费用上限的证据", () => {
    const input = {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.7.0",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-31T20:00:00.000Z",
      platform: "linux-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    };

    expect(() => createCertificationEvidence({ ...input, candidateArtifactSha256: "" })).toThrow(
      "缺少候选 Runtime Artifact SHA-256",
    );
    expect(() =>
      createCertificationEvidence({ ...input, usage: { ...input.usage, retries: 1 } }),
    ).toThrow("Provider 认证禁止自动重试");
    expect(() =>
      createCertificationEvidence({ ...input, usage: { ...input.usage, costUsd: 0.6 } }),
    ).toThrow("Provider 认证用量超过批准边界");

    expect(createCertificationEvidence(input)).toMatchObject({
      checkId: "P0-20",
      evidenceLevel: "live-provider",
      runtimeDigest: `sha256:${"d".repeat(64)}`,
      artifactManifestDigest: `sha256:${"e".repeat(64)}`,
      candidateArtifactSha256: "f".repeat(64),
      approval: { maxRetries: 0 },
      usage: { providerCalls: 10, retries: 0 },
    });
  });
});

describe("Provider 认证台账", () => {
  it("按 Provider 与版本替换记录，并保存提交与 Runtime 摘要", () => {
    const evidence = createCertificationEvidence({
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      version: "0.3.0-rc.2",
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      testedAt: "2026-08-12T18:00:00.000Z",
      platform: "win32-x64",
      node: "v22.22.1",
      details: completeDetails(3),
      ...completeBoundEvidence(),
    });
    const ledger = upsertCertificationRecord(
      {
        schemaVersion: 2,
        updatedAt: "2026-08-11",
        criteria: evidence.checks,
        certifications: [{ id: "alibaba-model-studio", version: "0.3.0-rc.2", evidence: "old" }],
      },
      evidence,
      "https://example.test/evidence.json",
    );

    expect(ledger.updatedAt).toBe("2026-08-12");
    expect(ledger.certifications).toHaveLength(1);
    expect(ledger.certifications[0]).toMatchObject({
      commit: "a".repeat(40),
      runtimeArtifactSha256: "b".repeat(64),
      evidence: "https://example.test/evidence.json",
    });
  });
});

function completeBoundEvidence() {
  return {
    candidateArtifactSha256: "f".repeat(64),
    runtimeDigest: `sha256:${"d".repeat(64)}`,
    artifactManifestDigest: `sha256:${"e".repeat(64)}`,
    ref: "https://github.com/Eclipseic1848/CoreMind/actions/runs/1",
    approval: {
      provider: "alibaba-model-studio",
      model: "qwen-plus",
      credentialEnv: "COREMIND_CERT_API_KEY",
      maxCostUsd: 0.5,
      maxDurationMs: 900_000,
      maxRetries: 0,
    },
    usage: {
      providerCalls: 10,
      inputTokens: 800,
      outputTokens: 200,
      totalTokens: 1_000,
      costUsd: 0.1,
      durationMs: 120_000,
      retries: 0,
    },
  };
}

function completeDetails(turns: number) {
  return {
    streaming: { passed: true },
    toolCall: { passed: true },
    structuredResult: { passed: true },
    multiTurn: { passed: true, turns },
    abort: { passed: true },
    error: { passed: true },
    longContext: { passed: true },
    childRun: {
      passed: true,
      parentProviderCalls: 2,
      delegationToolCalled: true,
      childProviderCalls: 2,
      childTool: "write",
      childToolCompleted: true,
      childOutcome: "succeeded",
      joined: true,
      quiescent: true,
      structuredResultSha256: "c".repeat(64),
    },
    childRunCancel: {
      passed: true,
      abortTriggeredAt: "child_text_delta",
      parentOutcome: "paused",
      childOutcome: "aborted",
      activeDescendants: 0,
      executionConverged: true,
      convergenceMs: 120,
      maxConvergenceMs: 5_000,
    },
  };
}
