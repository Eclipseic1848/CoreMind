import { describe, expect, it } from "vitest";
import { checkApiKeyEnvironment, resolveConfiguredApiKeyEnv } from "./doctor.js";

describe("doctor Provider 凭据检查", () => {
  it("优先使用配置声明的 apiKeyEnv", () => {
    expect(
      resolveConfiguredApiKeyEnv({
        provider: { id: "alibaba-model-studio", apiKeyEnv: " CUSTOM_PROVIDER_KEY " },
      }),
    ).toBe("CUSTOM_PROVIDER_KEY");
    expect(
      checkApiKeyEnvironment("CUSTOM_PROVIDER_KEY", { CUSTOM_PROVIDER_KEY: "test-key" }),
    ).toMatchObject({ ok: true, detail: expect.stringContaining("CUSTOM_PROVIDER_KEY 已配置") });
    expect(checkApiKeyEnvironment("CUSTOM_PROVIDER_KEY", {})).toEqual({
      ok: false,
      detail: "未配置：CUSTOM_PROVIDER_KEY（仅检查存在性）",
    });
  });

  it("识别 Alibaba 默认变量，其他未声明入口继续使用通用体检", () => {
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "alibaba-model-studio" } })).toBe(
      "DASHSCOPE_API_KEY",
    );
    expect(resolveConfiguredApiKeyEnv({ provider: { id: "deepseek" } })).toBeUndefined();
    expect(resolveConfiguredApiKeyEnv({})).toBeUndefined();
  });

  it("无配置文件时保留常见变量体检语义", () => {
    expect(checkApiKeyEnvironment(undefined, {})).toMatchObject({
      ok: false,
      detail: expect.stringContaining("DEEPSEEK_API_KEY"),
    });
    expect(checkApiKeyEnvironment(undefined, { OPENAI_API_KEY: "test-key" })).toMatchObject({
      ok: true,
      detail: expect.stringContaining("DEEPSEEK_API_KEY"),
    });
    expect(
      checkApiKeyEnvironment(undefined, {
        DEEPSEEK_API_KEY: "test-key",
        OPENAI_API_KEY: "test-key",
        MOONSHOT_API_KEY: "test-key",
        ZAI_API_KEY: "test-key",
      }),
    ).toEqual({
      ok: true,
      detail: "常见提供商 key 均已配置（仅检查存在性，未验证有效性）",
    });
  });
});
