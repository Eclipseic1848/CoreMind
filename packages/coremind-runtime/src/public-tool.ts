import type { AgentTool } from "@earendil-works/pi-agent-core";
import { CoreMindError } from "./errors.js";

export interface JsonObjectSchema extends Record<string, unknown> {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface CoreMindToolContext {
  callId: string;
  signal?: AbortSignal;
}

export interface CoreMindToolOutput {
  text: string;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

/** TypeScript 与跨语言工具共同使用的稳定公共契约。 */
export interface CoreMindToolDefinition<TArgs = Record<string, unknown>> {
  name: string;
  label?: string;
  description: string;
  parameters: JsonObjectSchema;
  execute: (
    args: TArgs,
    context: CoreMindToolContext,
  ) => Promise<CoreMindToolOutput | unknown> | CoreMindToolOutput | unknown;
}

export function defineTool<TArgs>(
  definition: CoreMindToolDefinition<TArgs>,
): CoreMindToolDefinition<TArgs> {
  if (definition.name.trim().length === 0) {
    throw new CoreMindError("invalid_tool", "工具 name 不能为空");
  }
  if (definition.description.trim().length === 0) {
    throw new CoreMindError("invalid_tool", `工具 ${definition.name} 的 description 不能为空`);
  }
  if (definition.parameters.type !== "object") {
    throw new CoreMindError(
      "invalid_tool",
      `工具 ${definition.name} 的 parameters.type 必须为 object`,
    );
  }
  return definition;
}

/** 仅供 Runtime Adapter 使用，不作为用户必须理解的接口。 */
export function adaptCoreMindTool(definition: CoreMindToolDefinition<any>): AgentTool {
  const valid = defineTool(definition);
  return {
    name: valid.name,
    label: valid.label ?? valid.name,
    description: valid.description,
    parameters: valid.parameters as AgentTool["parameters"],
    execute: async (callId, args, signal) => {
      const value = await valid.execute(args, { callId, signal });
      if (isToolOutput(value)) {
        return {
          content: [{ type: "text", text: value.text }],
          details: value.details ?? value,
          ...(value.isError !== undefined ? { isError: value.isError } : {}),
          ...(value.terminate !== undefined ? { terminate: value.terminate } : {}),
        } as ReturnTypeAdapter;
      }
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      return { content: [{ type: "text", text }], details: value };
    },
  } as AgentTool;
}

type ReturnTypeAdapter = Awaited<ReturnType<AgentTool["execute"]>> & { isError?: boolean };

function isToolOutput(value: unknown): value is CoreMindToolOutput {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { text?: unknown }).text === "string"
  );
}
