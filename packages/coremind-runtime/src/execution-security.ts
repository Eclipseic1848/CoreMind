import type { CoreMindConfig } from "coremind-config";
import { CoreMindError } from "./errors.js";

export interface ExecutionSecurityFinding {
  code: "invalid_config";
  message: string;
  path: string;
}

export type EnvironmentVariableExists = (name: string) => boolean;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "cookie",
]);

/** 对所有执行入口执行同一套无副作用配置安全检查。 */
export function inspectExecutionSecurity(
  config: CoreMindConfig,
  environmentVariableExists: EnvironmentVariableExists,
): ExecutionSecurityFinding[] {
  const findings: ExecutionSecurityFinding[] = [];
  const provider = config.provider;
  if (provider && "apiKey" in provider && provider.apiKey) {
    findings.push({
      code: "invalid_config",
      message: "配置中存在明文 apiKey；请改用 apiKeyEnv",
      path: "provider.apiKey",
    });
  }
  if (provider && "headers" in provider && provider.headers) {
    for (const name of Object.keys(provider.headers)) {
      if (!SENSITIVE_HEADER_NAMES.has(name.trim().toLowerCase())) continue;
      findings.push({
        code: "invalid_config",
        message: `敏感 Header ${name} 不允许使用字面量`,
        path: `provider.headers.${name}`,
      });
    }
  }
  if (provider?.apiKeyEnv && !environmentVariableExists(provider.apiKeyEnv)) {
    findings.push({
      code: "invalid_config",
      message: `配置引用的环境变量 ${provider.apiKeyEnv} 不存在或为空`,
      path: "provider.apiKeyEnv",
    });
  }
  return findings;
}

/** 在创建任何执行依赖前失败关闭不安全配置。 */
export function enforceExecutionSecurity(
  config: CoreMindConfig,
  environmentVariableExists: EnvironmentVariableExists,
): void {
  const finding = inspectExecutionSecurity(config, environmentVariableExists)[0];
  if (finding) throw new CoreMindError(finding.code, finding.message);
}
