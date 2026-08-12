export function assertCertificationSucceeded(result, label) {
  if (result.outcome.status === "succeeded") return;
  const error = result.outcome.error;
  const details = [result.outcome.finishReason, error?.code, error?.message]
    .filter(Boolean)
    .join(" / ");
  throw new Error(`${label}失败：${details}`);
}

const REQUIRED_DETAIL_KEYS = [
  "streaming",
  "toolCall",
  "structuredResult",
  "multiTurn",
  "abort",
  "error",
  "longContext",
];

/** 只在七项真实检查完整通过后生成可提交的认证证据。 */
export function createCertificationEvidence({
  provider,
  model,
  testedAt,
  platform,
  node,
  version,
  commit,
  runtimeArtifactSha256,
  details,
}) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("Provider 认证证据缺少 CoreMind 版本");
  }
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error("Provider 认证证据缺少完整 Git commit");
  }
  if (!/^[0-9a-f]{64}$/.test(runtimeArtifactSha256 ?? "")) {
    throw new Error("Provider 认证证据缺少 Runtime Artifact SHA-256");
  }
  for (const key of REQUIRED_DETAIL_KEYS) {
    if (details?.[key]?.passed !== true) {
      throw new Error(`Provider 认证检查未通过：${key}`);
    }
  }
  if (!Number.isInteger(details.multiTurn.turns) || details.multiTurn.turns < 3) {
    throw new Error("Provider 多轮会话认证至少需要三轮");
  }

  return {
    schemaVersion: 2,
    provider,
    model,
    version,
    commit,
    runtimeArtifactSha256,
    testedAt,
    platform,
    node,
    checks: [
      "streaming",
      "tool-call",
      "structured-result",
      "multi-turn",
      "abort",
      "error",
      "long-context",
    ],
    details,
    dataPolicy: "synthetic-only",
    secretsRecorded: false,
  };
}

/** 以 Provider 和版本为唯一键更新认证台账，避免同一候选出现互相矛盾的记录。 */
export function upsertCertificationRecord(ledger, evidence, evidenceUrl) {
  if (ledger?.schemaVersion !== 2 || !Array.isArray(ledger.certifications)) {
    throw new Error("Provider 认证台账格式无效");
  }
  const record = {
    id: evidence.provider,
    model: evidence.model,
    version: evidence.version,
    commit: evidence.commit,
    runtimeArtifactSha256: evidence.runtimeArtifactSha256,
    testedAt: evidence.testedAt,
    checks: [...evidence.checks],
    evidence: evidenceUrl,
  };
  return {
    ...ledger,
    updatedAt: evidence.testedAt.slice(0, 10),
    certifications: [
      ...ledger.certifications.filter(
        (item) => !(item.id === record.id && item.version === record.version),
      ),
      record,
    ],
  };
}
