import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import { buildProviderRuntime } from "./provider.js";

describe("buildProviderRuntime（内置提供商）", () => {
  it("缺省 provider 解析为 deepseek 默认模型", async () => {
    const runtime = await buildProviderRuntime();
    expect(runtime.model.provider).toBe("deepseek");
    expect(runtime.model.id).toBeTruthy();
    expect(runtime.warnings).toEqual([]);
    expect(runtime.promptCacheStatus).toBe(
      runtime.model.cost.cacheRead > 0 || runtime.model.cost.cacheWrite > 0
        ? "available"
        : "unavailable",
    );
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

  it("完整继承锁定 pi-agent 版本的 37 个静态 Provider", async () => {
    const { listInheritedProviders } = await import("./provider.js");
    const providers = listInheritedProviders();
    expect(providers).toHaveLength(39);
    expect(providers).toContain("xiaomi");
    expect((await buildProviderRuntime({ id: "xiaomi" })).model.provider).toBe("xiaomi");
  });

  it("提供可认证的阿里云模型服务原生入口", async () => {
    const { listSupportedProviders } = await import("./provider.js");
    expect(listSupportedProviders()).toContain("alibaba-model-studio");
    const runtime = await buildProviderRuntime(
      { id: "alibaba-model-studio", model: "qwen-plus" },
      { DASHSCOPE_API_KEY: "test-key" },
    );
    expect(runtime.model).toMatchObject({
      provider: "alibaba-model-studio",
      id: "qwen-plus",
      baseUrl: "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    });
    expect(runtime.apiKeyOverride).toBe("test-key");
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

  it("显式注入 env 时不读取宿主机同名凭据", async () => {
    const original = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "host-secret";
    try {
      const runtime = await buildProviderRuntime({ id: "deepseek" }, {
        DEEPSEEK_API_KEY: "injected-secret",
      } as NodeJS.ProcessEnv);
      const auth = await runtime.models.getAuth(runtime.model);
      expect(auth?.auth.apiKey).toBe("injected-secret");

      const isolated = await buildProviderRuntime({ id: "deepseek" }, {} as NodeJS.ProcessEnv);
      expect(await isolated.models.getAuth(isolated.model)).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
    }
  });

  it("显式 apiKeyEnv 缺失时不回退提供商默认变量", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek", apiKeyEnv: "MY_DS_KEY" }, {
      DEEPSEEK_API_KEY: "must-not-be-used",
    } as NodeJS.ProcessEnv);
    expect(runtime.apiKeyOverride).toBeUndefined();
    expect(await runtime.models.getAuth(runtime.model)).toBeUndefined();
  });

  it("未配置 apiKeyEnv 时无 override", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek" });
    expect(runtime.apiKeyOverride).toBeUndefined();
  });
});

describe("buildProviderRuntime（自定义 OpenAI 兼容端点）", () => {
  it("构造正确的模型与 provider", async () => {
    const runtime = await buildProviderRuntime(
      {
        id: "ollama",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5:7b",
        apiKeyEnv: "OLLAMA_API_KEY",
      },
      { OLLAMA_API_KEY: "test-key" } as NodeJS.ProcessEnv,
    );
    expect(runtime.model).toMatchObject({
      id: "qwen2.5:7b",
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    // cost 字段必须齐全（计费计算依赖）
    expect(runtime.model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(runtime.promptCacheStatus).toBe("unavailable");
    expect(runtime.warnings).toEqual([]);
  });

  it("默认 id 为 custom、默认 env 按 id 推断", async () => {
    const runtime = await buildProviderRuntime({
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "local-model",
    });
    expect(runtime.model.provider).toBe("custom");
  });

  it("apiKey 直填可用（静态鉴权，无 env 依赖），但告警引导 apiKeyEnv", async () => {
    const runtime = await buildProviderRuntime({
      id: "gateway",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m1",
      apiKey: "sk-test",
    });
    expect(runtime.model.provider).toBe("gateway");
    expect(runtime.warnings[0]).toContain("apiKeyEnv");
  });

  it("自定义提供商只从显式注入 env 解析密钥", async () => {
    const original = process.env.GATEWAY_API_KEY;
    process.env.GATEWAY_API_KEY = "host-secret";
    try {
      const runtime = await buildProviderRuntime(
        {
          id: "gateway",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "m1",
        },
        { GATEWAY_API_KEY: "injected-secret" } as NodeJS.ProcessEnv,
      );
      expect((await runtime.models.getAuth(runtime.model))?.auth.apiKey).toBe("injected-secret");

      const isolated = await buildProviderRuntime(
        {
          id: "gateway",
          baseUrl: "http://127.0.0.1:8080/v1",
          model: "m1",
        },
        {} as NodeJS.ProcessEnv,
      );
      expect(await isolated.models.getAuth(isolated.model)).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.GATEWAY_API_KEY;
      else process.env.GATEWAY_API_KEY = original;
    }
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
