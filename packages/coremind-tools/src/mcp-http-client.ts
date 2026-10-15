import type { ArtifactStore } from "./artifact-store.js";
import { ManagedMcpClient, type McpClient, type McpToolResult } from "./mcp-client.js";
import {
  createMcpHttpTransport,
  isMcpHttpFatalError,
  type McpHttpDomainSummary,
  type McpHttpTransportOptions,
} from "./mcp-http-transport.js";

export type { McpHttpDomainSummary } from "./mcp-http-transport.js";

export interface McpHttpClientOptions extends McpHttpTransportOptions {
  protocolVersion?: "legacy" | "2026-07-28";
  artifactStore: ArtifactStore;
  allowedResourceUris?: readonly string[];
}

export interface McpHttpClient extends McpClient<McpHttpDomainSummary> {
  listResources(signal?: AbortSignal): Promise<McpToolResult>;
  listResourceTemplates(signal?: AbortSignal): Promise<McpToolResult>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpToolResult>;
}

/** 工厂零 I/O；资源精确授权集合与连接输入在此冻结。 */
export function createMcpHttpClient(options: McpHttpClientOptions): McpHttpClient {
  const frozen = {
    ...options,
    headers: Object.freeze({ ...options.headers }),
    ...(options.allowedAddresses !== undefined
      ? { allowedAddresses: Object.freeze([...options.allowedAddresses]) }
      : {}),
    sensitiveValues: Object.freeze([...(options.sensitiveValues ?? [])]),
    allowedResourceUris: Object.freeze([...(options.allowedResourceUris ?? [])]),
  };
  return new ManagedMcpClient({
    ...frozen,
    mode: "http",
    transport: createMcpHttpTransport(frozen),
    isFatalTransportError: isMcpHttpFatalError,
  });
}
