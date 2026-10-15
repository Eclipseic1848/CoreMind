import { type Static, Type } from "@sinclair/typebox";
import { EnvironmentValueRefSchema, HeaderValueSchema, SecretRefSchema } from "./provider.js";

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

/** 固定 HTTP 目标；地址与 Header 的语义边界由无 I/O 校验和实际出站共同检查。 */
export const McpHttpServerConfigSchema = Type.Object(
  {
    transport: Type.Literal("streamable-http"),
    url: Type.String({ minLength: 1 }),
    headers: Type.Optional(Type.Record(Type.String(), HeaderValueSchema)),
    allowedAddresses: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    ),
    protocolVersion: Type.Optional(
      Type.Union([Type.Literal("legacy"), Type.Literal("2026-07-28")], { default: "legacy" }),
    ),
  },
  { additionalProperties: false },
);

export const McpConfigSchema = Type.Object(
  {
    servers: Type.Record(
      Type.String({ pattern: "^.+$" }),
      Type.Union([McpStdioServerConfigSchema, McpHttpServerConfigSchema]),
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type McpConfig = Static<typeof McpConfigSchema>;
export type McpStdioServerConfig = Static<typeof McpStdioServerConfigSchema>;
export type McpHttpServerConfig = Static<typeof McpHttpServerConfigSchema>;
