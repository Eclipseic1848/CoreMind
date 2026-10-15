import type { CoreMindConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";

export interface ExecutionSecurityFinding {
  code: "execution_security_violation" | "secret_reference_unresolved";
  message: string;
  path: string;
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-goog-api-key",
  "x-amz-security-token",
  "cookie",
]);

/** 对所有执行入口执行同一套无副作用配置安全检查。 */
export function inspectExecutionSecurity(config: CoreMindConfig): ExecutionSecurityFinding[] {
  const findings: ExecutionSecurityFinding[] = [];
  const provider = config.provider;
  if (provider && "apiKey" in provider && provider.apiKey) {
    findings.push({
      code: "execution_security_violation",
      message: "配置中存在明文 apiKey；请改用 apiKeyEnv",
      path: "provider.apiKey",
    });
  }
  const headerSources: Array<{ path: string; headers: Record<string, unknown> }> = [];
  if (provider && "headers" in provider && provider.headers) {
    headerSources.push({ path: "provider.headers", headers: provider.headers });
  }
  for (const [name, server] of Object.entries(config.mcp?.servers ?? {})) {
    if (server.transport === "streamable-http" && server.headers) {
      headerSources.push({ path: `mcp.servers.${name}.headers`, headers: server.headers });
    }
  }
  for (const source of headerSources) {
    for (const name of Object.keys(source.headers)) {
      if (!SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase())) continue;
      if (typeof source.headers[name] !== "string") continue;
      findings.push({
        code: "execution_security_violation",
        message: `敏感 Header ${name} 不允许使用字面量`,
        path: `${source.path}.${name}`,
      });
    }
  }
  return findings;
}

/** 在创建任何执行依赖前失败关闭不安全配置。 */
export function enforceExecutionSecurity(config: CoreMindConfig): void {
  const finding = inspectExecutionSecurity(config)[0];
  if (finding) throw new CoreMindError(finding.code, finding.message);
}
