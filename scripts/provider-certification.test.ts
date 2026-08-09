import { describe, expect, it } from "vitest";
import { assertCertificationSucceeded } from "./provider-certification.mjs";

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
  });
});
