import type { JsonObjectSchema } from "./public-tool.js";

/** 实际声明与历史重建共用的固定元工具合同，不携带执行或权限状态。 */
export const TOOL_DISCOVERY_DECLARATION: {
  name: string;
  description: string;
  parameters: JsonObjectSchema;
} = Object.freeze({
  name: "discover_tools",
  description:
    "按中英文关键词查找本 Agent 已授权且尚未声明的工具；命中项在下一请求前安装，使用时仍须审批。",
  parameters: {
    type: "object" as const,
    properties: {
      query: { type: "string", minLength: 1, maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 8 },
    },
    required: ["query"],
    additionalProperties: false,
  },
});
