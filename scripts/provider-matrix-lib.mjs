const REQUIRED_CERTIFICATION_CHECKS = [
  "streaming",
  "tool-call",
  "structured-result",
  "multi-turn",
  "abort",
  "error",
  "long-context",
];

/** 用运行时目录和人工证据台账生成认证矩阵，未提供完整证据时绝不自动认证。 */
export function buildProviderMatrix({ providers, certifications, generatedAt, targetVersion }) {
  const certificationById = new Map(certifications.map((item) => [item.id, item]));
  const rows = [...providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const certification = certificationById.get(provider.id);
      const certified = certification
        ? hasCompleteEvidence(certification) && certification.version === targetVersion
        : false;
      const missingChecks = certification ? missingCertificationChecks(certification) : [];
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
        ...(!certified && certification && hasCompleteEvidence(certification)
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
    summary: {
      supported: rows.length,
      certified: rows.filter((item) => item.status === "certified").length,
      unverified: rows.filter((item) => item.status === "inherited-unverified").length,
    },
    providers: rows,
  };
}

function hasCompleteEvidence(certification) {
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
  return missingCertificationChecks(certification).length === 0;
}

function missingCertificationChecks(certification) {
  const checks = new Set(certification.checks ?? []);
  const missing = REQUIRED_CERTIFICATION_CHECKS.filter((check) => !checks.has(check));
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
