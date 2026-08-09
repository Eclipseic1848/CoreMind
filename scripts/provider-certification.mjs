export function assertCertificationSucceeded(result, label) {
  if (result.outcome.status === "succeeded") return;
  const error = result.outcome.error;
  const details = [result.outcome.finishReason, error?.code, error?.message]
    .filter(Boolean)
    .join(" / ");
  throw new Error(`${label}失败：${details}`);
}
