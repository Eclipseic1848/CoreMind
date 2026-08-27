import { describe, expect, it } from "vitest";
import { ERROR_CODES, normalizeExternalErrorCode } from "./index.js";

describe("Error Contract", () => {
  it("每个登记码都有稳定名称和完整分类", () => {
    for (const [code, info] of Object.entries(ERROR_CODES)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(info.terminality).toMatch(/^(terminal|pausable|transient)$/);
      expect(info.cancelClass).toMatch(/^(cancel|timeout|budget|human|corruption|other)$/);
      expect(info.retryClass).toMatch(/^(human|transient|fatal)$/);
      expect(info.humanAction).toMatch(/^(required|none)$/);
    }
  });

  it("未知外部错误暂停并要求人工处置，且禁止自动重试", () => {
    expect(ERROR_CODES.unclassified_error).toEqual({
      terminality: "pausable",
      cancelClass: "human",
      retryClass: "human",
      humanAction: "required",
    });
  });

  it("未知外部错误只把原始码保留为审计信息", () => {
    expect(normalizeExternalErrorCode("vendor_overloaded_v3")).toEqual({
      code: "unclassified_error",
      audit: { originalCode: "vendor_overloaded_v3" },
    });
  });

  it("已登记外部错误保持既有公开码", () => {
    expect(normalizeExternalErrorCode("provider_timeout")).toEqual({
      code: "provider_timeout",
    });
  });
});
