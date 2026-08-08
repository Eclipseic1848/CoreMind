import path from "node:path";
import { type CoreMindConfig, checkProject, loadConfigFile, parseAndValidate } from "coremind-ai";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { dim, errorLine, green, yellow } from "../render.js";

const PROFILES = new Set(["development", "standard", "strict"]);

/** coremind check：执行配置、安全和项目材料静态门禁。 */
export async function cmdCheck(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0] ?? "coremind.yaml";
  let config: CoreMindConfig;
  try {
    config = parseAndValidate(await loadConfigFile(file)).config;
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  const profile = flagString(parsed, "profile");
  if (profile && !PROFILES.has(profile)) {
    console.error(errorLine("--profile 只能是 development、standard 或 strict"));
    return 1;
  }
  const report = await checkProject({
    config,
    projectDir: path.dirname(path.resolve(file)),
    ...(profile ? { profile: profile as "development" | "standard" | "strict" } : {}),
    overrideReason: flagString(parsed, "override-reason"),
  });

  if (flagBool(parsed, "json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.passed ? 0 : 1;
  }

  for (const finding of report.findings) {
    const prefix = finding.overridden
      ? "OVERRIDE"
      : finding.severity === "error"
        ? "ERROR"
        : "WARN";
    const line = `${prefix} ${finding.code}${finding.path ? ` [${finding.path}]` : ""}：${finding.message}`;
    console.log(
      finding.overridden
        ? yellow(line)
        : finding.severity === "error"
          ? errorLine(line)
          : yellow(line),
    );
  }
  if (report.overrideRecord) {
    console.log(dim(`覆盖已留痕：${report.overrideRecord.reason}`));
  }
  console.log(
    report.passed
      ? green(`✓ ${report.profile} 质量门禁通过`)
      : errorLine(`${report.profile} 质量门禁未通过`),
  );
  return report.passed ? 0 : 1;
}
