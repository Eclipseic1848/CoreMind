export function assertCertificationSucceeded(result, label) {
  if (result.outcome.status === "succeeded") return;
  const error = result.outcome.error;
  const details = [result.outcome.finishReason, error?.code, error?.message]
    .filter(Boolean)
    .join(" / ");
  throw new Error(`${label}失败：${details}`);
}

const REQUIRED_DETAIL_KEYS = ["streaming", "toolCall", "structuredResult", "multiTurn", "error"];

/** 只在五项真实检查完整通过后生成可提交的认证证据。 */
export function createCertificationEvidence({
  provider,
  model,
  testedAt,
  platform,
  node,
  version,
  details,
}) {
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("Provider 认证证据缺少 CoreMind 版本");
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
    schemaVersion: 1,
    provider,
    model,
    version,
    testedAt,
    platform,
    node,
    checks: ["streaming", "tool-call", "structured-result", "multi-turn", "error"],
    details,
    dataPolicy: "synthetic-only",
    secretsRecorded: false,
  };
}
