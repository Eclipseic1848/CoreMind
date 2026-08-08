export interface ContractReviewResult {
  riskLevel: "low" | "medium" | "high";
  summary: string;
  requiresHumanReview: boolean;
}

/** 示例宿主可在消费 Runtime transcript 前做第二次结构校验。 */
export function parseContractReview(text: string): ContractReviewResult {
  const value = JSON.parse(text) as Partial<ContractReviewResult>;
  if (
    !["low", "medium", "high"].includes(value.riskLevel ?? "") ||
    typeof value.summary !== "string" ||
    typeof value.requiresHumanReview !== "boolean"
  ) {
    throw new Error("合同审核结果结构无效");
  }
  return value as ContractReviewResult;
}
