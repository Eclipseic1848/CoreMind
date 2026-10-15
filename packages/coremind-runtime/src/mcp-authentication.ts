import { type CoreMindConfig, validateConfig } from "coremind-config";
import type { McpAuthentication, McpTokenStore } from "coremind-tools";
import { createMcpAuthenticationEngine } from "coremind-tools/internal";
import { enforceExecutionSecurity } from "./execution-security.js";
import { identifyServer } from "./mcp-runtime.js";

export type {
  McpAuthentication,
  McpAuthenticationResult,
  McpAuthorizationHandler,
  McpAuthorizationRequest,
  McpLoginOptions,
  McpTokenRecord,
  McpTokenStore,
} from "coremind-tools";

export interface McpAuthenticationOptions {
  config: CoreMindConfig;
  tokenStore?: McpTokenStore;
  namespace?: string;
}

/** 宿主显式拥有认证会话；创建不出站，单次 Run 不负责注销或关闭它。 */
export async function createMcpAuthentication(
  options: McpAuthenticationOptions,
): Promise<McpAuthentication> {
  const config = validateConfig(options.config);
  enforceExecutionSecurity(config);
  const servers = [];
  for (const [server, configured] of Object.entries(config.mcp?.servers ?? {})) {
    if (configured.transport !== "streamable-http" || !configured.oauth) continue;
    const selected = structuredClone(configured);
    const identity = await identifyServer(server, selected);
    servers.push({ server, config: selected, serverIdentity: identity.sha256 });
  }
  return createMcpAuthenticationEngine({
    servers,
    network: config.permissions?.network ?? "ask",
    tokenStore: options.tokenStore,
    namespace: options.namespace,
  });
}
