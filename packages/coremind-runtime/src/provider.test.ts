import { describe, expect, it } from "vitest";
import { CoreMindError } from "./errors.js";
import {
  buildProviderRuntime,
  contextCapabilityCandidatesForModel,
  listInheritedProviders,
  listSupportedProviders,
  resolveProviderModel,
} from "./provider.js";

process.env.DEEPSEEK_API_KEY = "test-only";

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
    expect(runtime.contextCapabilityCandidates).toEqual([
      {
        providerId: runtime.model.provider,
        modelId: runtime.model.id,
        contextWindow: runtime.model.contextWindow,
        maxOutputTokens: runtime.model.maxTokens,
        source: "locked_catalog",
        confidence: "verified",
      },
    ]);
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

  it("命名 Agent 不能把内置 Provider 路由到目录外模型", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek" });
    expect(() => resolveProviderModel(runtime, "unknown-agent-model")).toThrowError(
      expect.objectContaining({ code: "no_models" }),
    );
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
      const runtime = await buildProviderRuntime(
        { id, apiKeySecretRef: { secretRef: `opaque/${id}` } },
        {},
        { resolve: async () => "test-only" },
      );
      expect(runtime.model.provider).toBe(id);
      expect(runtime.model.id).toBeTruthy();
    }
  });

  it("内置目录包含 42 个提供商，兼容别名单独作为配置入口", async () => {
    const providers = listInheritedProviders();
    expect(providers).toHaveLength(42);
    expect(providers).toContain("azure");
    expect(providers).toContain("typesafe");
    expect(providers).not.toContain("azure-openai-responses");
    expect(listSupportedProviders()).toHaveLength(43);
    expect(new Set(listSupportedProviders()).size).toBe(43);
    expect(listSupportedProviders()).toContain("azure-openai-responses");
    expect(listSupportedProviders()).not.toContain("typesafe");
    expect(providers).toContain("xiaomi");
    expect(
      (
        await buildProviderRuntime(
          { id: "xiaomi", apiKeySecretRef: { secretRef: "opaque/xiaomi" } },
          {},
          { resolve: async () => "test-only" },
        )
      ).model.provider,
    ).toBe("xiaomi");
  });

  it("仅有非聊天模型的提供商不能作为 Agent 聊天入口", async () => {
    await expect(buildProviderRuntime({ id: "typesafe" }, {})).rejects.toMatchObject({
      code: "no_models",
    });
  });

  it("Azure 新旧配置入口解析为相同模型，且不改写原始配置", async () => {
    const env = { AZURE_OPENAI_API_KEY: "azure-test-key" };
    const canonical = await buildProviderRuntime({ id: "azure" }, env);
    const legacyConfig = Object.freeze({
      id: "azure-openai-responses",
      model: canonical.model.id,
    });
    const legacy = await buildProviderRuntime(legacyConfig, env);
    expect(legacyConfig.id).toBe("azure-openai-responses");
    expect(legacy.model).toEqual(canonical.model);
    expect(legacy.contextCapabilityCandidates).toEqual(canonical.contextCapabilityCandidates);
    expect(legacy.warnings).toEqual([expect.stringContaining("实际路由为 azure")]);
  });

  it.each(["azure", "azure-openai-responses"])("%s 保留默认 Azure 环境变量鉴权", async (id) => {
    const runtime = await buildProviderRuntime({ id }, { AZURE_OPENAI_API_KEY: "default-key" });
    expect(runtime.apiKeyOverride).toBeUndefined();
    expect(await runtime.models.getAuth(runtime.model)).toMatchObject({
      auth: { apiKey: "default-key" },
    });
    await expect(buildProviderRuntime({ id }, {})).rejects.toMatchObject({
      code: "secret_reference_unresolved",
    });
  });

  it.each(["azure", "azure-openai-responses"])(
    "%s 显式环境变量是唯一密钥来源，缺失时不回退",
    async (id) => {
      const runtime = await buildProviderRuntime(
        { id, apiKeyEnv: "MY_AZURE_KEY" },
        { MY_AZURE_KEY: "explicit-key", AZURE_OPENAI_API_KEY: "must-not-be-used" },
      );
      expect(runtime.apiKeyOverride).toBe("explicit-key");
      expect(await runtime.models.getAuth(runtime.model)).toBeUndefined();
      await expect(
        buildProviderRuntime(
          { id, apiKeyEnv: "MY_AZURE_KEY" },
          { AZURE_OPENAI_API_KEY: "must-not-be-used" },
        ),
      ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
    },
  );

  it.each(["azure", "azure-openai-responses"])(
    "%s 显式秘密引用是唯一密钥来源，无法解析时不回退",
    async (id) => {
      const cfg = { id, apiKeySecretRef: { secretRef: "opaque/azure" } };
      const env = { AZURE_OPENAI_API_KEY: "must-not-be-used" };
      const runtime = await buildProviderRuntime(cfg, env, {
        resolve: async (ref) => (ref === "opaque/azure" ? "resolved-key" : undefined),
      });
      expect(runtime.apiKeyOverride).toBe("resolved-key");
      expect(await runtime.models.getAuth(runtime.model)).toBeUndefined();
      await expect(
        buildProviderRuntime(cfg, env, { resolve: async () => undefined }),
      ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
    },
  );

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
    expect(runtime.contextCapabilityCandidates[0]).toMatchObject({
      source: "locked_catalog",
      confidence: "verified",
      contextWindow: 131072,
      maxOutputTokens: 8192,
    });
  });

  it("阿里云原生入口接受 SecretRef 且不读取默认环境变量", async () => {
    const runtime = await buildProviderRuntime(
      { id: "alibaba-model-studio", apiKeySecretRef: { secretRef: "opaque/alibaba" } },
      { DASHSCOPE_API_KEY: "must-not-be-used" },
      { resolve: async () => "resolved-alibaba" },
    );
    expect(runtime.apiKeyOverride).toBe("resolved-alibaba");
    expect(await runtime.models.getAuth(runtime.model)).toMatchObject({
      auth: { apiKey: "resolved-alibaba" },
    });
  });

  it("apiKeyEnv 配置时解析为 apiKeyOverride", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek", apiKeyEnv: "MY_DS_KEY" }, {
      MY_DS_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    expect(runtime.apiKeyOverride).toBe("sk-test");
    expect(runtime.warnings).toEqual([]);
  });

  it("apiKeyEnv 配置但 env 缺失时失败关闭", async () => {
    await expect(
      buildProviderRuntime({ id: "deepseek", apiKeyEnv: "NO_SUCH_KEY" }, {} as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
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

      await expect(
        buildProviderRuntime({ id: "deepseek" }, {} as NodeJS.ProcessEnv),
      ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
    }
  });

  it("显式 apiKeyEnv 缺失时不回退提供商默认变量", async () => {
    await expect(
      buildProviderRuntime({ id: "deepseek", apiKeyEnv: "MY_DS_KEY" }, {
        DEEPSEEK_API_KEY: "must-not-be-used",
      } as NodeJS.ProcessEnv),
    ).rejects.toMatchObject({ code: "secret_reference_unresolved" });
  });

  it("未配置 apiKeyEnv 时无 override", async () => {
    const runtime = await buildProviderRuntime({ id: "deepseek" });
    expect(runtime.apiKeyOverride).toBeUndefined();
  });

  it("内置 Provider 显式 SecretRef 时不回退默认环境变量", async () => {
    const runtime = await buildProviderRuntime(
      { id: "deepseek", apiKeySecretRef: { secretRef: "opaque/deepseek" } },
      { DEEPSEEK_API_KEY: "must-not-be-used" },
      { resolve: async () => "resolved-deepseek" },
    );
    expect(runtime.apiKeyOverride).toBe("resolved-deepseek");
    expect(await runtime.models.getAuth(runtime.model)).toBeUndefined();
  });
});

describe("buildProviderRuntime（自定义 OpenAI 兼容端点）", () => {
  it.each(["azure", "azure-openai-responses"])(
    "自定义 %s 同名入口保留自己的路由、模型与秘密引用",
    async (id) => {
      const cfg = Object.freeze({
        id,
        baseUrl: "https://gateway.example/v1",
        model: "custom-model",
        apiKeySecretRef: { secretRef: "opaque/custom-azure" },
        headers: { "X-Gateway": "custom" },
      });
      const runtime = await buildProviderRuntime(
        cfg,
        { AZURE_OPENAI_API_KEY: "must-not-be-used" },
        { resolve: async () => "custom-key" },
      );
      expect(runtime.model).toMatchObject({
        provider: id,
        id: "custom-model",
        baseUrl: cfg.baseUrl,
      });
      expect(runtime.models.getProvider(id)?.headers).toEqual(cfg.headers);
      expect(await runtime.models.getAuth(runtime.model)).toMatchObject({
        auth: { apiKey: "custom-key" },
      });
      expect(runtime.apiKeyOverride).toBe("custom-key");
      expect(runtime.warnings).toEqual([]);
      expect(cfg.id).toBe(id);
    },
  );

  it("只在 Provider Adapter 接缝解析 SecretRef", async () => {
    const resolved = "resolved-only-in-adapter";
    const runtime = await buildProviderRuntime(
      {
        id: "gateway",
        baseUrl: "http://127.0.0.1:8080/v1",
        model: "m1",
        apiKeySecretRef: { secretRef: "opaque/api-key" },
        headers: { Authorization: { secretRef: "opaque/header" } },
      },
      {},
      { resolve: async () => resolved },
    );

    expect(runtime.apiKeyOverride).toBe(resolved);
    expect(runtime.models.getProvider("gateway")?.headers).toEqual({ Authorization: resolved });
  });
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
      const isolatedAuth = await isolated.models.getAuth(isolated.model);
      expect(isolated.apiKeyOverride).toBeUndefined();
      expect(isolatedAuth?.auth.headers).toEqual({ authorization: null });
      expect(isolatedAuth?.auth.apiKey).not.toBe("host-secret");
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
    expect(big.contextCapabilityCandidates).toEqual([
      {
        providerId: "big",
        modelId: "m1",
        contextWindow: 131072,
        maxOutputTokens: 8192,
        source: "explicit_config",
        confidence: "declared",
      },
    ]);

    const fallback = await buildProviderRuntime({
      id: "default",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "m1",
    });
    expect(fallback.model.contextWindow).toBe(32768);
    expect(fallback.model.maxTokens).toBe(4096);
    expect(fallback.contextCapabilityCandidates).toEqual([
      {
        providerId: "default",
        modelId: "m1",
        contextWindow: 32768,
        maxOutputTokens: 4096,
        source: "conservative_fallback",
        confidence: "assumed",
      },
    ]);
  });

  it("自定义兼容端点允许命名 Agent 固定同 Provider 的独立模型", async () => {
    const runtime = await buildProviderRuntime({
      id: "gateway",
      baseUrl: "http://127.0.0.1:8080/v1",
      model: "default-model",
      contextWindow: 65536,
      maxTokens: 2048,
    });
    const targetModel = resolveProviderModel(runtime, "reviewer-model");

    expect(targetModel).toMatchObject({
      provider: "gateway",
      id: "reviewer-model",
      baseUrl: "http://127.0.0.1:8080/v1",
      contextWindow: 65536,
      maxTokens: 2048,
    });
    expect(contextCapabilityCandidatesForModel(runtime, targetModel)).toEqual([
      expect.objectContaining({
        providerId: "gateway",
        modelId: "reviewer-model",
        source: "explicit_config",
        confidence: "declared",
      }),
    ]);
  });
});
