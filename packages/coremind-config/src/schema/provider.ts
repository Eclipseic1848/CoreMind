import { Type } from "@sinclair/typebox";

/** 内置 provider 引用：只写 id，apiKey 默认按 id 推断环境变量名 */
export const ProviderRefSchema = Type.Object({
  id: Type.String({
    minLength: 1,
    description: "内置提供商 id，如 deepseek / moonshotai-cn / zai",
  }),
  model: Type.Optional(Type.String({ description: "模型名，缺省按提供商取默认模型" })),
  apiKeyEnv: Type.Optional(
    Type.String({ description: "API key 环境变量名，缺省按 id 推断（如 DEEPSEEK_API_KEY）" }),
  ),
});

/** 自定义 OpenAI 兼容端点（Ollama / 本地模型 / 网关 / 私有部署） */
export const CustomProviderSchema = Type.Object({
  id: Type.Optional(
    Type.String({ minLength: 1, default: "custom", description: "自定义提供商标识" }),
  ),
  name: Type.Optional(Type.String()),
  baseUrl: Type.String({ minLength: 1, description: "端点地址，如 http://localhost:11434/v1" }),
  model: Type.String({ minLength: 1, description: "模型名，如 qwen2.5:7b" }),
  api: Type.Optional(
    Type.Literal("openai-completions", {
      default: "openai-completions",
      description: "接口协议，一期仅支持 openai-completions",
    }),
  ),
  apiKey: Type.Optional(Type.String({ description: "直接写 API key（不建议，优先用 apiKeyEnv）" })),
  apiKeyEnv: Type.Optional(Type.String({ description: "API key 环境变量名" })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "附加请求头" })),
  contextWindow: Type.Optional(
    Type.Integer({
      minimum: 1024,
      description: "模型上下文窗口（token），缺省按 32768 兜底",
    }),
  ),
  maxTokens: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "模型最大输出 token 数，缺省按 4096 兜底",
    }),
  ),
});

/**
 * provider 字段：内置引用或自定义端点，缺省为 deepseek。
 * 注意：自定义端点（含 baseUrl 判别字段）必须放在 Union 首位，
 * 否则宽松的内置引用会先命中并吞掉 baseUrl 等字段。
 */
export const ProviderSchema = Type.Union([CustomProviderSchema, ProviderRefSchema]);

/** 模型选项（temperature / maxTokens / thinkingLevel） */
export const ModelOptionsSchema = Type.Object({
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2, default: 0.7 })),
  maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  thinkingLevel: Type.Optional(
    Type.Union([
      Type.Literal("off"),
      Type.Literal("low"),
      Type.Literal("medium"),
      Type.Literal("high"),
      Type.Literal("xhigh"),
    ]),
  ),
});
