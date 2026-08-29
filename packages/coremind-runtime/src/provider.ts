import {
  type ApiKeyAuth,
  type AuthContext,
  createModels,
  createProvider,
  envApiKeyAuth,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { builtinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { CustomProviderConfig, ProviderConfig } from "coremind-config";
import type { ContextCapabilityCandidate } from "./context-lifecycle.js";
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
  /** 每次请求重新解析的模型能力来源；不得从 Session 旧值或 UI Projection 反推。 */
  contextCapabilityCandidates: ContextCapabilityCandidate[];
  /** 自定义兼容端点允许命名 Agent 在同一 Provider 内选择未列入单模型目录的模型。 */
  acceptsUnlistedModels: boolean;
}

/** 从项目 Provider 的固定路由中解析命名 Agent 模型；内置目录不允许静默回退。 */
export function resolveProviderModel(runtime: ProviderRuntime, modelId?: string): Model<any> {
  if (!modelId || modelId === runtime.model.id) return runtime.model;
  const matched = runtime.models
    .getModels(runtime.model.provider)
    .find((model) => model.id === modelId);
  if (matched) return matched;
  if (runtime.acceptsUnlistedModels) {
    return { ...runtime.model, id: modelId, name: modelId };
  }
  throw new CoreMindError(
    "no_models",
    `命名 Agent 配置的模型 ${modelId} 不在 Provider ${runtime.model.provider} 的锁定目录中`,
  );
}

/** 为实际 Agent 模型生成同源能力候选，避免用项目默认模型替代请求事实。 */
export function contextCapabilityCandidatesForModel(
  runtime: ProviderRuntime,
  model: Model<any>,
): ContextCapabilityCandidate[] {
  if (model.id === runtime.model.id) return runtime.contextCapabilityCandidates;
  const origin = runtime.contextCapabilityCandidates[0];
  return [
    contextCapability(
      model,
      origin?.source ?? "conservative_fallback",
      origin?.confidence ?? "assumed",
    ),
  ];
}

/** 宿主注入的后端无关秘密解析接缝；引用和值都不得离开 Provider Adapter。 */
export interface SecretResolver {
  resolve(ref: string): string | undefined | Promise<string | undefined>;
}

interface ResolvedProviderSecurity {
  apiKey?: string;
  headers?: Record<string, string>;
}

class ProviderSecurityError extends CoreMindError {
  constructor(
    code: "execution_security_violation" | "secret_reference_unresolved",
    message: string,
    readonly path: string,
  ) {
    super(code, message);
  }
}

export function providerSecurityErrorPath(error: CoreMindError): string | undefined {
  return error instanceof ProviderSecurityError ? error.path : undefined;
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
  secretResolver?: SecretResolver,
): Promise<ProviderRuntime> {
  const cfg = providerCfg ?? { id: DEFAULT_PROVIDER };
  const security = await resolveProviderSecurity(cfg, env, secretResolver);
  if ("baseUrl" in cfg) {
    return buildCustomRuntime(cfg, env, security);
  }
  if (cfg.id === "alibaba-model-studio") {
    return buildAlibabaModelStudioRuntime(cfg, env, security);
  }
  return buildBuiltinRuntime(cfg, env, security.apiKey);
}

/** 阿里云模型服务的中国区试用域名；任意同区域工作区密钥均可调用。 */
async function buildAlibabaModelStudioRuntime(
  cfg: {
    id: string;
    model?: string;
    apiKeyEnv?: string;
    apiKeySecretRef?: { secretRef: string };
  },
  env: NodeJS.ProcessEnv,
  security: ResolvedProviderSecurity,
): Promise<ProviderRuntime> {
  const modelId = cfg.model ?? "qwen-plus";
  const apiKeyEnv = cfg.apiKeyEnv ?? "DASHSCOPE_API_KEY";
  if (!security.apiKey && !nonEmpty(env[apiKeyEnv])) throw unresolved("apiKeyEnv");
  return buildCustomRuntime(
    {
      id: cfg.id,
      name: "Alibaba Cloud Model Studio",
      baseUrl: "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      model: modelId,
      apiKeyEnv,
      contextWindow: 131072,
      maxTokens: 8192,
    },
    env,
    security,
    { source: "locked_catalog", confidence: "verified" },
  );
}

/** 内置提供商：注册工厂，从目录解析模型（model 未命中时回退默认并告警） */
async function buildBuiltinRuntime(
  cfg: { id: string; model?: string; apiKeyEnv?: string; apiKeySecretRef?: unknown },
  env: NodeJS.ProcessEnv,
  resolvedApiKey?: string,
): Promise<ProviderRuntime> {
  const models = builtinModels({
    authContext: isolatedAuthContext(env, cfg.apiKeyEnv, cfg.apiKeySecretRef !== undefined),
  });
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
  if (!resolvedApiKey && !(await models.getAuth(model))) throw unresolved("apiKeyEnv");
  // apiKeyEnv 覆盖：显式名称是唯一来源，不允许再回退到宿主机或提供商默认变量。
  const apiKeyOverride = resolvedApiKey;
  return {
    models,
    model,
    warnings,
    apiKeyOverride,
    promptCacheStatus: cacheStatus(model),
    contextCapabilityCandidates: [contextCapability(model, "locked_catalog", "verified")],
    acceptsUnlistedModels: false,
  };
}

/** 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关） */
async function buildCustomRuntime(
  cfg: CustomProviderConfig,
  env: NodeJS.ProcessEnv,
  security: ResolvedProviderSecurity,
  capabilityOrigin?: Pick<ContextCapabilityCandidate, "source" | "confidence">,
): Promise<ProviderRuntime> {
  const id = cfg.id ?? "custom";
  const apiKeyEnv = inferEnv(cfg, id);
  const models = createModels({ authContext: isolatedAuthContext(env, apiKeyEnv) });
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
      headers: security.headers,
      auth: {
        apiKey: security.apiKey
          ? staticKeyAuth(security.apiKey)
          : envApiKeyAuth(cfg.name ?? id, [apiKeyEnv]),
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  );
  const apiKeyOverride = cfg.apiKey ? undefined : (security.apiKey ?? env[apiKeyEnv]);
  return {
    models,
    model,
    warnings,
    ...(apiKeyOverride ? { apiKeyOverride } : {}),
    promptCacheStatus: cacheStatus(model),
    contextCapabilityCandidates: [
      contextCapability(
        model,
        capabilityOrigin?.source ??
          (cfg.contextWindow === undefined ? "conservative_fallback" : "explicit_config"),
        capabilityOrigin?.confidence ?? (cfg.contextWindow === undefined ? "assumed" : "declared"),
      ),
    ],
    acceptsUnlistedModels: true,
  };
}

/** 只在 Provider Adapter 边界把引用解析为短生命周期字符串。 */
export async function resolveProviderSecurity(
  cfg: ProviderConfig,
  env: NodeJS.ProcessEnv,
  secretResolver?: SecretResolver,
): Promise<ResolvedProviderSecurity> {
  if (cfg.apiKeyEnv && cfg.apiKeySecretRef) {
    throw new ProviderSecurityError(
      "execution_security_violation",
      "apiKeyEnv 与 apiKeySecretRef 不能同时配置",
      "provider",
    );
  }

  let apiKey: string | undefined;
  if (cfg.apiKeyEnv) {
    apiKey = nonEmpty(env[cfg.apiKeyEnv]);
    if (!apiKey) throw unresolved("apiKeyEnv");
  } else if (cfg.apiKeySecretRef) {
    apiKey = await resolveOpaqueSecret(secretResolver, cfg.apiKeySecretRef.secretRef);
    if (!apiKey) throw unresolved("apiKeySecretRef");
  }

  if (!("headers" in cfg) || !cfg.headers) return apiKey ? { apiKey } : {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(cfg.headers)) {
    if (typeof value === "string") {
      headers[name] = value;
      continue;
    }
    const resolved =
      "env" in value
        ? nonEmpty(env[value.env])
        : await resolveOpaqueSecret(secretResolver, value.secretRef);
    if (!resolved) throw unresolved(`headers.${name}`);
    headers[name] = resolved;
  }
  return { ...(apiKey ? { apiKey } : {}), headers };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function resolveOpaqueSecret(
  resolver: SecretResolver | undefined,
  ref: string,
): Promise<string | undefined> {
  try {
    return nonEmpty(await resolver?.resolve(ref));
  } catch {
    return undefined;
  }
}

function unresolved(field: string): CoreMindError {
  return new ProviderSecurityError(
    "secret_reference_unresolved",
    `${field} 引用无法解析`,
    `provider.${field}`,
  );
}

function contextCapability(
  model: Model<any>,
  source: ContextCapabilityCandidate["source"],
  confidence: ContextCapabilityCandidate["confidence"],
): ContextCapabilityCandidate {
  return {
    providerId: model.provider,
    modelId: model.id,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
    source,
    confidence,
  };
}

/** 只暴露调用方注入的环境；显式 apiKeyEnv 时仅允许读取该变量，禁止宿主凭据回退。 */
function isolatedAuthContext(
  env: NodeJS.ProcessEnv,
  apiKeyEnv?: string,
  denyEnvironment = false,
): AuthContext {
  return {
    env: async (name) => {
      if (denyEnvironment) return undefined;
      return apiKeyEnv && name !== apiKeyEnv ? undefined : env[name];
    },
    fileExists: async () => false,
  };
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
    reasoning: cfg.thinkingFormat !== undefined,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // contextWindow/maxTokens：配置可覆盖（对齐真实模型能力），缺省保守兜底
    contextWindow: cfg.contextWindow ?? 32768,
    maxTokens: cfg.maxTokens ?? 4096,
    compat: cfg.thinkingFormat ? { thinkingFormat: cfg.thinkingFormat } : undefined,
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
