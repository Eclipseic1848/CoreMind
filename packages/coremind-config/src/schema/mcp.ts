import { type Static, Type } from "@sinclair/typebox";
import { EnvironmentValueRefSchema, SecretRefSchema } from "./provider.js";

const NonEmptyProcessStringSchema = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });

/** 本地服务只使用固定 stdio 命令；凭据值由宿主在授权后解析。 */
export const McpStdioServerConfigSchema = Type.Object(
  {
    transport: Type.Literal("stdio"),
    command: NonEmptyProcessStringSchema,
    args: Type.Array(Type.String({ pattern: "^[^\\u0000]*$" })),
    cwd: NonEmptyProcessStringSchema,
    env: Type.Optional(
      Type.Record(
        Type.String({ pattern: "^[^=\\u0000]+$" }),
        Type.Union([EnvironmentValueRefSchema, SecretRefSchema]),
        { additionalProperties: false },
      ),
    ),
    protocolVersion: Type.Optional(
      Type.Union([Type.Literal("legacy"), Type.Literal("2026-07-28")], { default: "legacy" }),
    ),
  },
  { additionalProperties: false },
);

export const McpConfigSchema = Type.Object(
  {
    servers: Type.Record(Type.String({ pattern: "^.+$" }), McpStdioServerConfigSchema, {
      additionalProperties: false,
    }),
  },
  { additionalProperties: false },
);

export type McpConfig = Static<typeof McpConfigSchema>;
export type McpStdioServerConfig = Static<typeof McpStdioServerConfigSchema>;
