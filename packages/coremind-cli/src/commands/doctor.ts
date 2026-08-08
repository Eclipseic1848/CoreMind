import path from "node:path";
import { CoreMindRuntime, loadConfigFile, parseAndValidate } from "coremind-ai";
import type { ParsedArgs } from "../args.js";
import { dim, green, red, yellow } from "../render.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * coremind doctor [file]：环境自检。
 * 检查 Node 版本、配置文件可解析、provider 注册可用性、常见 env 变量。
 */
export async function cmdDoctor(_parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const checks: CheckResult[] = [];

  // 1. Node 版本
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node 版本",
    ok: nodeMajor >= 22,
    detail: `v${process.versions.node}（要求 >= 22.19）`,
  });

  // 2. 配置文件（可选）
  const file = positionals[0];
  if (file) {
    try {
      const data = await loadConfigFile(file);
      const result = parseAndValidate(data);
      checks.push({
        name: `配置文件 ${file}`,
        ok: true,
        detail: result.warnings.length > 0 ? `${result.warnings.length} 条告警` : "校验通过",
      });
      // 3. provider 构建可用性
      try {
        const _runtime = await CoreMindRuntime.create({
          config: result.config,
          configDir: path.dirname(path.resolve(file)),
          cwd: process.cwd(),
          events: () => {},
        });
        const providerId = runtimeProviderId(result.config);
        checks.push({
          name: `提供商 ${providerId}`,
          ok: true,
          detail: "注册成功（未发送真实请求）",
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

  // 4. 常见 env 变量
  const envKeys = ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "MOONSHOT_API_KEY", "ZAI_API_KEY"];
  const missing = envKeys.filter((key) => !process.env[key]);
  checks.push({
    name: "API key 环境变量",
    ok: missing.length < envKeys.length,
    detail:
      missing.length === 0
        ? "常见提供商 key 均已配置（仅检查存在性，未验证有效性）"
        : `未配置：${missing.join("、")}（用不到的可以忽略；仅检查存在性）`,
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
