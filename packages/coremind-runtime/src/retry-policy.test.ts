import { describe, expect, it, vi } from "vitest";
import { CoreMindError } from "./errors.js";
import { classifyRetry, runWithTransientRetry } from "./retry-policy.js";

describe("retry policy", () => {
  it.each([
    [{ status: 429 }, "transient"],
    [{ statusCode: 503 }, "transient"],
    [Object.assign(new Error("reset"), { code: "ECONNRESET" }), "transient"],
    [new CoreMindError("approval_denied", "用户拒绝"), "human"],
    [new CoreMindError("unknown_effect", "副作用未知"), "human"],
    [new CoreMindError("invalid_config", "参数无效"), "permanent"],
    [new Error("未分类错误"), "human"],
  ] as const)("把 %o 分类为 %s", (error, category) => {
    expect(classifyRetry(error).category).toBe(category);
  });

  it("复用模型适配层的成熟分类器识别瞬态错误，未知配额错误要求人工处理", () => {
    const transient = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "503 service unavailable",
    };
    const quota = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "insufficient_quota: billing limit reached",
    };

    expect(classifyRetry(transient).category).toBe("transient");
    expect(classifyRetry(quota).category).toBe("human");
  });

  it("只重试瞬态错误并按顺序报告次数", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    await expect(runWithTransientRetry(operation, { maxRetries: 2, onRetry })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
  });

  it("确定性失败、人工处置和重试耗尽都立即抛出", async () => {
    const permanent = vi.fn().mockRejectedValue(new CoreMindError("invalid_config", "坏配置"));
    await expect(runWithTransientRetry(permanent, { maxRetries: 3 })).rejects.toThrow("坏配置");
    expect(permanent).toHaveBeenCalledOnce();

    const human = vi.fn().mockRejectedValue(new CoreMindError("unknown_effect", "需核对"));
    await expect(runWithTransientRetry(human, { maxRetries: 3 })).rejects.toThrow("需核对");
    expect(human).toHaveBeenCalledOnce();

    const transient = vi.fn().mockRejectedValue({ status: 503 });
    await expect(runWithTransientRetry(transient, { maxRetries: 1 })).rejects.toMatchObject({
      status: 503,
    });
    expect(transient).toHaveBeenCalledTimes(2);
  });

  it("未知外部异常要求人工处置且绝不重试", async () => {
    const operation = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("未知 Adapter 异常"), { code: "vendor_private_error" }),
      );

    await expect(runWithTransientRetry(operation, { maxRetries: 3 })).rejects.toMatchObject({
      code: "vendor_private_error",
    });
    expect(operation).toHaveBeenCalledOnce();
  });

  it("中止信号阻止下一次尝试", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw { status: 503 };
    });

    await expect(
      runWithTransientRetry(operation, { maxRetries: 3, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(operation).toHaveBeenCalledOnce();
  });
});
