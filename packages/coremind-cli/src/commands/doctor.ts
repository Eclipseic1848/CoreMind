import { inspectRuntimeCompatibility, loadConfigFile, parseAndValidate } from "coremind-ai";
import { buildProviderRuntime, enforceExecutionSecurity } from "coremind-ai/internal";
import type { ParsedArgs } from "../args.js";
import { dim, green, red, yellow } from "../render.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const COMMON_API_KEY_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "MOONSHOT_API_KEY",
  "ZAI_API_KEY",
];

/**
 * coremind doctor [file]：环境自检。
 * 检查 Node 版本、配置文件可解析、provider 注册可用性、常见 env 变量。
 */
export async function cmdDoctor(_parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const checks: CheckResult[] = [];
  let configuredApiKeyEnv: string | undefined;

  // 1. Node 版本
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node 版本",
    ok: nodeMajor >= 22,
    detail: `v${process.versions.node}（要求 >= 22.19）`,
  });

  const compatibility = inspectRuntimeCompatibility();
  checks.push({
    name: "Runtime 兼容层",
    ok: true,
    detail: `依赖族 ${compatibility.dependencyFamily} · Adapter v${compatibility.adapterVersion} · 错误映射 v${compatibility.errorMappingVersion}`,
  });

  // 2. 配置文件（可选）
  const file = positionals[0];
  if (file) {
    try {
      const data = await loadConfigFile(file);
      const result = parseAndValidate(data);
      configuredApiKeyEnv = resolveConfiguredApiKeyEnv(result.config);
      checks.push({
        name: `配置文件 ${file}`,
        ok: true,
        detail: result.warnings.length > 0 ? `${result.warnings.length} 条告警` : "校验通过",
      });
      const selectedTransports = Object.values(result.config.agents).flatMap((agent) =>
        [
          ...((agent.tools?.length ?? 0) > 0 ? agent.tools! : (result.config.tools ?? [])).flatMap(
            (tool) => ("mcp" in tool ? [tool.mcp.server] : []),
          ),
          ...Object.entries(agent.mcpResources ?? {}).flatMap(([name, uris]) =>
            uris.length > 0 ? [name] : [],
          ),
        ].map((name) => result.config.mcp?.servers[name]?.transport),
      );
      if (selectedTransports.includes("stdio")) {
        const supported =
          result.config.permissions?.workspaceOnly === false &&
          result.config.permissions?.network === "allow";
        checks.push({
          name: "本地 MCP 执行条件",
          ok: supported,
          detail: supported
            ? "已显式配置 trusted_host 权限；仅静态检查，未启动服务或验证握手"
            : "本地 MCP 仅支持 trusted_host：必须显式配置 workspaceOnly=false 和 network=allow；未启动服务，不会自动降低权限",
        });
      }
      if (selectedTransports.includes("streamable-http")) {
        const network = result.config.permissions?.network ?? "ask";
        checks.push({
          name: "HTTP MCP 执行条件",
          ok: network !== "deny",
          detail:
            network === "deny"
              ? "network=deny 拒绝 HTTP MCP；未连接服务，不会自动降低权限"
              : network === "ask"
                ? "实际网络请求仍需审批；仅静态检查，未连接服务或验证目标地址与握手"
                : "固定目标仍须通过实际出站校验；仅静态检查，未连接服务或验证目标地址与握手",
        });
      }
      // 3. provider 构建可用性
      try {
        enforceExecutionSecurity(result.config);
        await buildProviderRuntime(result.config.provider, process.env);
        const providerId = runtimeProviderId(result.config);
        checks.push({
          name: `提供商 ${providerId}`,
          ok: true,
          detail: "注册成功（仅静态检查，未加载项目脚本或发送真实请求；执行时脚本需要加载信任）",
        });
      } catch (error) {
        checks.push({
          name: "提供商注册",
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      checks.push({
        name: `配置文件 ${file}`,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 4. 配置文件声明了凭据来源时只检查该变量；无配置时保留通用体检。
  checks.push({
    name: "API key 环境变量",
    ...checkApiKeyEnvironment(configuredApiKeyEnv, process.env),
  });

  // 输出
  console.log("CoreMind 环境自检：\n");
  let allOk = true;
  for (const check of checks) {
    const mark = check.ok ? green("✓") : red("✗");
    console.log(`  ${mark} ${check.name}`);
    if (check.detail) console.log(`    ${dim(check.detail)}`);
    if (!check.ok) allOk = false;
  }
  console.log("");
  if (allOk) {
    console.log(green("全部正常 ✅"));
  } else {
    console.log(yellow("存在问题，请按上面提示修复。"));
  }
  return allOk ? 0 : 1;
}

function runtimeProviderId(config: {
  provider?: { id?: string } | { id?: string; baseUrl?: string };
}): string {
  return config.provider?.id ?? "deepseek";
}

export function resolveConfiguredApiKeyEnv(config: {
  provider?: { id?: string; apiKeyEnv?: string };
}): string | undefined {
  const explicit = config.provider?.apiKeyEnv?.trim();
  if (explicit) return explicit;
  return config.provider?.id === "alibaba-model-studio" ? "DASHSCOPE_API_KEY" : undefined;
}

export function checkApiKeyEnvironment(
  configuredApiKeyEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): Pick<CheckResult, "ok" | "detail"> {
  if (configuredApiKeyEnv) {
    const configured = Boolean(env[configuredApiKeyEnv]);
    return {
      ok: configured,
      detail: configured
        ? `${configuredApiKeyEnv} 已配置（仅检查存在性，未验证有效性）`
        : `未配置：${configuredApiKeyEnv}（仅检查存在性）`,
    };
  }

  const missing = COMMON_API_KEY_ENV_KEYS.filter((key) => !env[key]);
  return {
    ok: missing.length < COMMON_API_KEY_ENV_KEYS.length,
    detail:
      missing.length === 0
        ? "常见提供商 key 均已配置（仅检查存在性，未验证有效性）"
        : `未配置：${missing.join("、")}（用不到的可以忽略；仅检查存在性）`,
  };
}
