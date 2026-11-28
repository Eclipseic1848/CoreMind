import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/** 认证台账以整个 Worker 的 Runtime 内容摘要区分同版本的不同构建。 */
export async function readRuntimeDigest(rootDirectory) {
  const bundle = path.join(rootDirectory, "python/src/coremind/_worker/coremind-worker.mjs");
  try {
    const bytes = await readFile(bundle);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

const REQUIRED_CERTIFICATION_CHECKS = [
  "streaming",
  "tool-call",
  "structured-result",
  "multi-turn",
  "abort",
  "error",
  "long-context",
];
const CHILD_RUN_CERTIFICATION_CHECKS = [
  "parent-model-call",
  "delegation-tool",
  "child-model-call",
  "child-tool-call",
  "cancel-convergence",
];

/** 用运行时目录和人工证据台账生成认证矩阵，未提供完整证据时绝不自动认证。 */
export function buildProviderMatrix({
  providers,
  certifications,
  generatedAt,
  targetVersion,
  targetRuntimeDigest,
}) {
  const certificationById = new Map(certifications.map((item) => [item.id, item]));
  const rows = [...providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const certification = certificationById.get(provider.id);
      const certified = isCurrentCertification(certification, targetVersion, targetRuntimeDigest);
      const missingChecks = certification
        ? missingCertificationChecks(certification, targetVersion)
        : [];
      return {
        ...provider,
        status: certified ? "certified" : "inherited-unverified",
        ...(certified
          ? {
              testedVersion: certification.version,
              testedAt: certification.testedAt,
              testedModel: certification.model,
              testedCommit: certification.commit,
              runtimeArtifactSha256: certification.runtimeArtifactSha256,
              evidence: certification.evidence,
            }
          : {}),
        ...(!certified && certification && hasCompleteEvidence(certification, certification.version)
          ? {
              previousCertification: {
                version: certification.version,
                testedAt: certification.testedAt,
                testedModel: certification.model,
                testedCommit: certification.commit,
                runtimeArtifactSha256: certification.runtimeArtifactSha256,
                evidence: certification.evidence,
              },
            }
          : {}),
        ...(certification && missingChecks.length > 0 ? { certificationGap: missingChecks } : {}),
      };
    });

  const supportedIds = new Set(rows.map((item) => item.id));
  const unknownCertification = certifications.find((item) => !supportedIds.has(item.id));
  if (unknownCertification) {
    throw new Error(`认证台账包含运行时不存在的 Provider：${unknownCertification.id}`);
  }

  return {
    schemaVersion: 1,
    generatedAt,
    targetVersion,
    targetRuntimeDigest,
    summary: {
      supported: rows.length,
      certified: rows.filter((item) => item.status === "certified").length,
      unverified: rows.filter((item) => item.status === "inherited-unverified").length,
    },
    providers: rows,
  };
}

export function isCurrentCertification(certification, targetVersion, targetRuntimeDigest) {
  return (
    Boolean(certification) &&
    typeof targetRuntimeDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(targetRuntimeDigest) &&
    certification.runtimeDigest === targetRuntimeDigest &&
    certification.version === targetVersion &&
    hasCompleteEvidence(certification, targetVersion)
  );
}

function hasCompleteEvidence(certification, version) {
  if (
    !certification.version ||
    !certification.testedAt ||
    !certification.model ||
    !/^[0-9a-f]{40}$/.test(certification.commit ?? "") ||
    !/^[0-9a-f]{64}$/.test(certification.runtimeArtifactSha256 ?? "") ||
    !certification.evidence
  ) {
    return false;
  }
  return missingCertificationChecks(certification, version).length === 0;
}

function missingCertificationChecks(certification, version) {
  const checks = new Set(certification.checks ?? []);
  const required = requiresChildRunCertification(version)
    ? [...REQUIRED_CERTIFICATION_CHECKS, ...CHILD_RUN_CERTIFICATION_CHECKS]
    : REQUIRED_CERTIFICATION_CHECKS;
  const missing = required.filter((check) => !checks.has(check));
  if (!certification.version) missing.push("version");
  if (!certification.testedAt) missing.push("testedAt");
  if (!certification.model) missing.push("model");
  if (!/^[0-9a-f]{40}$/.test(certification.commit ?? "")) missing.push("commit");
  if (!/^[0-9a-f]{64}$/.test(certification.runtimeArtifactSha256 ?? "")) {
    missing.push("runtimeArtifactSha256");
  }
  if (!certification.evidence) missing.push("evidence");
  return missing;
}

function requiresChildRunCertification(version) {
  const match = /^(\d+)\.(\d+)\./u.exec(version ?? "");
  return match ? Number(match[1]) > 0 || Number(match[2]) >= 7 : false;
}
