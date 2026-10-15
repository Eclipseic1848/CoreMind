import type { ArtifactStore } from "./artifact-store.js";
import type { ExecutionEnvironment } from "./execution-environment.js";
import { ManagedMcpClient, type McpClient } from "./mcp-client.js";
import { McpStdioTransport } from "./mcp-stdio-transport.js";

export type { McpListedTool, McpToolResult as McpStdioToolResult } from "./mcp-client.js";

export interface McpStdioClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  runEnvironment: ExecutionEnvironment;
  signal?: AbortSignal;
  protocolVersion?: "legacy" | "2026-07-28";
  sensitiveValues?: readonly string[];
  artifactStore: ArtifactStore;
}

export interface McpStdioDomainSummary {
  readonly isolation: "trusted_host";
  readonly processControl: "process_tree";
  readonly networkEgress: "unrestricted";
  readonly credentialIsolation: "none";
  readonly platform: NodeJS.Platform;
  readonly evidence: readonly string[];
}

/** 兼容既有同仓接口；标准输入输出传输仍按连接整体取消。 */
export interface McpStdioClient extends McpClient<McpStdioDomainSummary> {}

/** 工厂仅冻结输入；SDK 与进程环境只在授权 connect 时加载。 */
export function createMcpStdioClient(options: McpStdioClientOptions): McpStdioClient {
  const frozen = {
    ...options,
    args: Object.freeze([...options.args]),
    env: Object.freeze({ ...options.env }),
    sensitiveValues: Object.freeze([...(options.sensitiveValues ?? [])]),
  };
  return new ManagedMcpClient({
    ...frozen,
    mode: "stdio",
    transport: new McpStdioTransport(frozen),
  });
}
