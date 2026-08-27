import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import { classifyExecutionError, normalizeExecutionError } from "./execution-error.js";

describe("execution error contract", () => {
  it("保留已注册 CoreMindError 的身份与语义", () => {
    const error = new CoreMindError("budget_exceeded", "预算已用尽");

    expect(normalizeExecutionError(error)).toBe(error);
    expect(classifyExecutionError(error)).toMatchObject({
      code: "budget_exceeded",
      retryClass: "fatal",
      message: "预算已用尽",
    });
  });

  it.each([
    [{ code: "ECONNRESET" }, "network_error"],
    [{ status: 408 }, "provider_timeout"],
    [{ statusCode: 429 }, "rate_limit"],
    [{ status: 503 }, "provider_unavailable"],
  ] as const)("把外部传输错误 %o 映射到 %s", (error, code) => {
    expect(classifyExecutionError(error)).toMatchObject({ code, retryClass: "transient" });
  });

  it("沿 cause 链识别已注册错误", () => {
    const cause = new CoreMindError("tool_approval_denied", "用户拒绝工具调用");
    const error = new Error("外层包装", { cause });

    expect(classifyExecutionError(error)).toMatchObject({
      code: "tool_approval_denied",
      retryClass: "human",
      message: "用户拒绝工具调用",
    });
  });

  it("未知错误只公开统一错误码并保留脱敏审计值", () => {
    const error = Object.assign(new Error("Bearer provider-secret"), {
      code: "vendor_failure?token=provider-secret",
    });

    expect(classifyExecutionError(error)).toEqual({
      code: "unclassified_error",
      retryClass: "human",
      message: "外部执行返回未分类错误，需人工审计后继续",
      audit: { originalCode: "vendor_failure?token=hidden" },
    });
  });

  it("未知对象错误的普通字符串字段也会全文脱敏", () => {
    expect(classifyExecutionError({ detail: "Bearer object-secret" })).toMatchObject({
      code: "unclassified_error",
      audit: { originalCode: '{"detail":"Bearer hidden"}' },
    });
  });

  it("未知异常消息中的无标签凭据前缀不会进入审计值", () => {
    expect(classifyExecutionError(new Error("sk-live-secret-value"))).toMatchObject({
      code: "unclassified_error",
      audit: { originalCode: "Error: credential-hidden" },
    });
  });
});
