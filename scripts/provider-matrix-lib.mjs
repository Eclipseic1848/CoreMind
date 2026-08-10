const REQUIRED_CERTIFICATION_CHECKS = [
  "streaming",
  "tool-call",
  "structured-result",
  "multi-turn",
  "error",
];

/** 用运行时目录和人工证据台账生成认证矩阵，未提供完整证据时绝不自动认证。 */
export function buildProviderMatrix({ providers, certifications, generatedAt }) {
  const certificationById = new Map(certifications.map((item) => [item.id, item]));
  const rows = [...providers]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((provider) => {
      const certification = certificationById.get(provider.id);
      const certified = certification ? hasCompleteEvidence(certification) : false;
      if (certification && !certified) {
        throw new Error(`Provider ${provider.id} 的认证证据不完整`);
      }
      return {
        ...provider,
        status: certified ? "certified" : "inherited-unverified",
        testedVersion: certification?.version,
        testedAt: certification?.testedAt,
        testedModel: certification?.model,
        evidence: certification?.evidence,
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
    !certification.evidence
  ) {
    return false;
  }
  const checks = new Set(certification.checks ?? []);
  return REQUIRED_CERTIFICATION_CHECKS.every((check) => checks.has(check));
}
