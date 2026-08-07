import { Type } from "@sinclair/typebox";
import { ModelOptionsSchema } from "./provider.js";
import { ToolConfigSchema } from "./tools.js";

/** 单个 agent 定义 */
export const AgentConfigSchema = Type.Object({
  model: Type.Optional(Type.String({ description: "模型名，缺省继承 provider.model" })),
  systemPrompt: Type.Optional(
    Type.String({ default: "你是一个乐于助人的助手。", description: "系统提示词" }),
  ),
  tools: Type.Optional(
    Type.Array(ToolConfigSchema, {
      default: [],
      description: "该 agent 可用的工具（缺省继承全局 tools）",
    }),
  ),
  options: Type.Optional(ModelOptionsSchema),
  description: Type.Optional(Type.String({ description: "给其他 agent 看的‘名片’描述" })),
  skills: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description:
        "注入的专业技能 id（如 code-review / weekly-report / translation），内容附加到系统提示词",
    }),
  ),
});

/** 会话配置（持久化开关） */
export const SessionConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: false, description: "是否持久化会话到本地 JSONL" }),
  dir: Type.Optional(Type.String({ description: "会话存储目录，缺省为 ./sessions" })),
  compact: Type.Optional(
    Type.Boolean({
      default: false,
      description: "上下文超预算时自动压缩（LLM 摘要，消耗 token；显式开启）",
    }),
  ),
});
