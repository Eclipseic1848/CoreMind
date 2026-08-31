import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createCertificationEvidence,
  upsertCertificationRecord,
} from "./provider-certification.mjs";
import { verifyProviderCertificationArtifact } from "./verify-provider-certification-artifact.mjs";

describe("候选 Provider 认证 Artifact", () => {
  it("只接受与候选提交及台账交叉匹配的完整证据", async () => {
    const directory = createArtifact("a".repeat(40));

    await expect(
      verifyProviderCertificationArtifact(directory, "a".repeat(40)),
    ).resolves.toMatchObject({ provider: "alibaba-model-studio", model: "qwen-plus" });
    await expect(verifyProviderCertificationArtifact(directory, "c".repeat(40))).rejects.toThrow(
      "没有绑定候选提交",
    );
  });

  it("拒绝与证据不一致的认证台账", async () => {
    const directory = createArtifact("a".repeat(40), "b".repeat(64));
    const ledgerFile = path.join(directory, "certifications.json");
    const ledger = JSON.parse(
      await import("node:fs/promises").then(({ readFile }) => readFile(ledgerFile, "utf8")),
    );
    ledger.certifications[0].runtimeArtifactSha256 = "c".repeat(64);
    writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");

    await expect(verifyProviderCertificationArtifact(directory, "a".repeat(40))).rejects.toThrow(
      "认证台账与证据不一致",
    );
  });
});

function createArtifact(commit: string, runtimeArtifactSha256 = "b".repeat(64)) {
  const directory = mkdtempSync(path.join(tmpdir(), "coremind-provider-artifact-"));
  const evidenceDirectory = path.join(directory, "evidence");
  mkdirSync(evidenceDirectory);
  const evidence = createCertificationEvidence({
    provider: "alibaba-model-studio",
    model: "qwen-plus",
    version: "0.7.0",
    commit,
    runtimeArtifactSha256,
    testedAt: "2026-08-27T20:00:00.000Z",
    platform: "linux-x64",
    node: "v22.22.1",
    details: completeDetails(),
    candidateArtifactSha256: "c".repeat(64),
    runtimeDigest: `sha256:${"d".repeat(64)}`,
    artifactManifestDigest: `sha256:${"e".repeat(64)}`,
    ref: "https://example.test/run/1",
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
  });
  writeFileSync(
    path.join(evidenceDirectory, "candidate.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  const ledger = upsertCertificationRecord(
    { schemaVersion: 2, updatedAt: "2026-08-27", criteria: evidence.checks, certifications: [] },
    evidence,
    "https://example.test/candidate.json",
  );
  writeFileSync(
    path.join(directory, "certifications.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function completeDetails() {
  return {
    streaming: { passed: true },
    toolCall: { passed: true },
    structuredResult: { passed: true },
    multiTurn: { passed: true, turns: 3 },
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
      structuredResultSha256: "f".repeat(64),
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
