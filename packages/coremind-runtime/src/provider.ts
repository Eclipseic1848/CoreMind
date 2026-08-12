import {
  type ApiKeyAuth,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { builtinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomProviderConfig, ProviderConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";

export interface ProviderRuntime {
  /** 模型集合（含鉴权、流式调用） */
  models: Models;
  /** 解析出的当前模型（默认或配置指定） */
  model: Model<any>;
  /** 解析警告（如配置的模型不在目录中） */
  warnings: string[];
  /** 配置 apiKeyEnv 时从该环境变量解析出的 key（覆盖内置 provider 默认环境变量） */
  apiKeyOverride?: string;
  /** 仅依据锁定模型目录的缓存计费元数据判定，不把 0 命中伪装为命中。 */
  promptCacheStatus: "available" | "unavailable";
}

const DEFAULT_PROVIDER = "deepseek";
const CORE_MIND_PROVIDER_IDS = ["alibaba-model-studio"] as const;

/** 锁定 pi-ai 版本提供的完整静态 Provider 清单。 */
export function listInheritedProviders(): string[] {
  return [...getBuiltinProviders()];
}

/** CoreMind 可直接配置的完整 Provider 清单，包括继承入口与原生认证入口。 */
export function listSupportedProviders(): string[] {
  return [...listInheritedProviders(), ...CORE_MIND_PROVIDER_IDS];
}

/** 构建运行时：注册 provider 并解析模型 */
export async function buildProviderRuntime(
  providerCfg?: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderRuntime> {
  const cfg = providerCfg ?? { id: DEFAULT_PROVIDER };
  if ("baseUrl" in cfg) {
    return buildCustomRuntime(cfg);
  }
  if (cfg.id === "alibaba-model-studio") {
    return buildAlibabaModelStudioRuntime(cfg, env);
  }
  return buildBuiltinRuntime(cfg, env);
}

/** 阿里云模型服务的中国区试用域名；任意同区域工作区密钥均可调用。 */
async function buildAlibabaModelStudioRuntime(
  cfg: { id: string; model?: string; apiKeyEnv?: string },
  env: NodeJS.ProcessEnv,
): Promise<ProviderRuntime> {
  const modelId = cfg.model ?? "qwen-plus";
  const apiKeyEnv = cfg.apiKeyEnv ?? "DASHSCOPE_API_KEY";
  const runtime = await buildCustomRuntime({
    id: cfg.id,
    name: "Alibaba Cloud Model Studio",
    baseUrl: "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    model: modelId,
    apiKeyEnv,
    contextWindow: 131072,
    maxTokens: 8192,
  });
  const apiKeyOverride = env[apiKeyEnv];
  if (!apiKeyOverride) runtime.warnings.push(`环境变量 ${apiKeyEnv} 未配置`);
  return { ...runtime, apiKeyOverride };
}

/** 内置提供商：注册工厂，从目录解析模型（model 未命中时回退默认并告警） */
async function buildBuiltinRuntime(
  cfg: { id: string; model?: string; apiKeyEnv?: string },
  env: NodeJS.ProcessEnv,
): Promise<ProviderRuntime> {
  const models = builtinModels();
  const provider = models.getProvider(cfg.id);
  if (!provider) {
    throw new CoreMindError(
      "unknown_provider",
      `不支持的内置提供商：${cfg.id}。锁定版本继承：${listInheritedProviders().join("、")}。如需其他模型服务，请使用自定义 provider（baseUrl 方式）。`,
    );
  }

  const catalog = models.getModels(cfg.id);
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
  return { models, model, warnings, apiKeyOverride, promptCacheStatus: cacheStatus(model) };
}

/** 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关） */
async function buildCustomRuntime(cfg: CustomProviderConfig): Promise<ProviderRuntime> {
  const models = createModels();
  const id = cfg.id ?? "custom";
  const model = buildCustomModel(cfg, id);
  // apiKey 直填告警：密钥会随配置文件进入版本库/分享链路，引导用 apiKeyEnv
  const warnings: string[] = [];
  if (cfg.apiKey) {
    warnings.push(
      "配置了 apiKey 直填：密钥会随配置文件进入版本库/分享链路，建议改用 apiKeyEnv 环境变量",
    );
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
  return { models, model, warnings, promptCacheStatus: cacheStatus(model) };
}

function cacheStatus(model: Model<any>): "available" | "unavailable" {
  return model.cost.cacheRead > 0 || model.cost.cacheWrite > 0 ? "available" : "unavailable";
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
