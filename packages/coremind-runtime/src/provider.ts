import {
  type ApiKeyAuth,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import type { CustomProviderConfig, ProviderConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";

/** 内置提供商白名单（id → 工厂） */
const BUILTIN_PROVIDERS: Record<string, () => Provider> = {
  deepseek: deepseekProvider,
  "moonshotai-cn": moonshotaiCnProvider,
  zai: zaiProvider,
  "minimax-cn": minimaxCnProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
};

export interface ProviderRuntime {
  /** 模型集合（含鉴权、流式调用） */
  models: Models;
  /** 解析出的当前模型（默认或配置指定） */
  model: Model<any>;
  /** 解析警告（如配置的模型不在目录中） */
  warnings: string[];
  /** 配置 apiKeyEnv 时从该环境变量解析出的 key（覆盖内置 provider 默认环境变量） */
  apiKeyOverride?: string;
}

const DEFAULT_PROVIDER = "deepseek";

/** 构建运行时：注册 provider 并解析模型 */
export async function buildProviderRuntime(
  providerCfg?: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderRuntime> {
  const cfg = providerCfg ?? { id: DEFAULT_PROVIDER };
  if ("baseUrl" in cfg) {
    return buildCustomRuntime(cfg);
  }
  return buildBuiltinRuntime(cfg, env);
}

/** 内置提供商：注册工厂，从目录解析模型（model 未命中时回退默认并告警） */
async function buildBuiltinRuntime(
  cfg: { id: string; model?: string; apiKeyEnv?: string },
  env: NodeJS.ProcessEnv,
): Promise<ProviderRuntime> {
  const factory = BUILTIN_PROVIDERS[cfg.id];
  if (!factory) {
    throw new CoreMindError(
      "unknown_provider",
      `不支持的内置提供商：${cfg.id}。支持：${Object.keys(BUILTIN_PROVIDERS).join("、")}。如需其他模型服务，请使用自定义 provider（baseUrl 方式）。`,
    );
  }
  const provider = factory();
  const models = createModels();
  models.setProvider(provider);

  const catalog = provider.getModels();
  const fallback = catalog[0];
  if (!fallback) {
    throw new CoreMindError("no_models", `提供商 ${cfg.id} 没有可用的模型目录`);
  }

  let model = fallback;
  const warnings: string[] = [];
  if (cfg.model) {
    const matched = catalog.find((m) => m.id === cfg.model);
    if (matched) {
      model = matched;
    } else {
      warnings.push(
        `配置的模型 ${cfg.model} 不在 ${cfg.id} 的模型目录中，已改用默认模型 ${fallback.id}（可用：${catalog.map((m) => m.id).join("、")}）`,
      );
    }
  }
  // apiKeyEnv 覆盖：配置了指定 env 变量时，把它的值作为每次请求的 apiKey（替代默认变量）
  const apiKeyOverride = cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined;
  if (cfg.apiKeyEnv && !apiKeyOverride) {
    warnings.push(
      `配置的 apiKeyEnv ${cfg.apiKeyEnv} 未在环境中找到，将回退使用 ${cfg.id} 的默认环境变量`,
    );
  }
  return { models, model, warnings, apiKeyOverride };
}

/** 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关） */
async function buildCustomRuntime(cfg: CustomProviderConfig): Promise<ProviderRuntime> {
  const models = createModels();
  const id = cfg.id ?? "custom";
  const model = buildCustomModel(cfg, id);
  // apiKey 直填告警：密钥会随配置文件进入版本库/分享链路，引导用 apiKeyEnv
  const warnings: string[] = [];
  if (cfg.apiKey) {
    warnings.push("配置了 apiKey 直填：密钥会随配置文件进入版本库/分享链路，建议改用 apiKeyEnv 环境变量");
  }
  models.setProvider(
    createProvider({
      id,
      name: cfg.name,
      baseUrl: cfg.baseUrl,
      headers: cfg.headers,
      auth: {
        apiKey: cfg.apiKey
          ? staticKeyAuth(cfg.apiKey)
          : envApiKeyAuth(cfg.name ?? id, [inferEnv(cfg, id)]),
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  return { models, model, warnings };
}

/** 手工构造 OpenAI 兼容 Model 对象。cost 必须给全 0（计费计算缺字段出 NaN） */
function buildCustomModel(cfg: CustomProviderConfig, id: string): Model<any> {
  return {
    id: cfg.model,
    name: cfg.model,
    api: "openai-completions",
    provider: id,
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // contextWindow/maxTokens：配置可覆盖（对齐真实模型能力），缺省保守兜底
    contextWindow: cfg.contextWindow ?? 32768,
    maxTokens: cfg.maxTokens ?? 4096,
  };
}

/** 自定义 provider 的 env 变量名推断：id 转大写 + 下划线，如 ollama → OLLAMA_API_KEY */
function inferEnv(cfg: CustomProviderConfig, id: string): string {
  if (cfg.apiKeyEnv) return cfg.apiKeyEnv;
  return `${id.toUpperCase().replaceAll("-", "_")}_API_KEY`;
}

/** 配置里直接写 apiKey 时的静态鉴权（resolve 无副作用） */
function staticKeyAuth(apiKey: string): ApiKeyAuth {
  return {
    name: "API key（配置文件）",
    resolve: async () => ({ auth: { apiKey }, source: "config" }),
  };
}
