import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import { buildProviderRuntime } from "./provider.js";

describe("buildProviderRuntime（内置提供商）", () => {
  it("缺省 provider 解析为 deepseek 默认模型", async () => {
    const runtime = await buildProviderRuntime();
    expect(runtime.model.provider).toBe("deepseek");
    expect(runtime.model.id).toBeTruthy();
    expect(runtime.warnings).toEqual([]);
  });

  it("配置的 model 命中目录", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek", model: "deepseek-v4-pro" });
    expect(runtime.model.id).toBe("deepseek-v4-pro");
    expect(runtime.warnings).toEqual([]);
  });

  it("配置的 model 未命中时回退默认并告警", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek", model: "deepseek-chat" });
    expect(runtime.model.id).not.toBe("deepseek-chat");
    expect(runtime.warnings[0]).toContain("deepseek-chat");
  });

  it("未知内置提供商抛 CoreMindError", async () => {
    await expect(buildProviderRuntime({ id: "not-a-provider" })).rejects.toThrow(CoreMindError);
    try {
      await buildProviderRuntime({ id: "not-a-provider" });
    } catch (e) {
      expect((e as CoreMindError).code).toBe("unknown_provider");
    }
  });

  it("其他内置提供商可解析（moonshotai-cn / zai / minimax-cn）", async () => {
    for (const id of ["moonshotai-cn", "zai", "minimax-cn"]) {
      const runtime = await buildProviderRuntime({ id });
      expect(runtime.model.provider).toBe(id);
      expect(runtime.model.id).toBeTruthy();
    }
  });

  it("apiKeyEnv 配置时解析为 apiKeyOverride", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek", apiKeyEnv: "MY_DS_KEY" }, {
      MY_DS_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    expect(runtime.apiKeyOverride).toBe("sk-test");
    expect(runtime.warnings).toEqual([]);
  });

  it("apiKeyEnv 配置但 env 缺失时回退默认并告警", async () => {
    const runtime = await buildProviderRuntime(
      { id: "deepseek", apiKeyEnv: "NO_SUCH_KEY" },
      {} as NodeJS.ProcessEnv,
    );
    expect(runtime.apiKeyOverride).toBeUndefined();
    expect(runtime.warnings[0]).toContain("NO_SUCH_KEY");
  });

  it("未配置 apiKeyEnv 时无 override", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek" });
    expect(runtime.apiKeyOverride).toBeUndefined();
  });
});

describe("buildProviderRuntime（自定义 OpenAI 兼容端点）", () => {
  it("构造正确的模型与 provider", async () => {
    const runtime = await buildProviderRuntime({
      id: "ollama",
      baseUrl: "http://localhost:11434/v1",
      model: "qwen2.5:7b",
      apiKeyEnv: "OLLAMA_API_KEY",
    });
    expect(runtime.model).toMatchObject({
      id: "qwen2.5:7b",
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    // cost 字段必须齐全（计费计算依赖）
    expect(runtime.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(runtime.warnings).toEqual([]);
  });

  it("默认 id 为 custom、默认 env 按 id 推断", async () => {
    const runtime = await buildProviderRuntime({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-model",
    });
    expect(runtime.model.provider).toBe("custom");
  });

  it("apiKey 直填可用（静态鉴权，无 env 依赖）", async () => {
    const runtime = await buildProviderRuntime({
      id: "gateway",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m1",
      apiKey: "sk-test",
    });
    expect(runtime.model.provider).toBe("gateway");
  });

  it("contextWindow/maxTokens 可配置覆盖，缺省保守兜底", async () => {
    const big = await buildProviderRuntime({
      id: "big",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m1",
      contextWindow: 131072,
      maxTokens: 8192,
    });
    expect(big.model.contextWindow).toBe(131072);
    expect(big.model.maxTokens).toBe(8192);

    const fallback = await buildProviderRuntime({
      id: "default",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m1",
    });
    expect(fallback.model.contextWindow).toBe(32768);
    expect(fallback.model.maxTokens).toBe(4096);
  });
});
