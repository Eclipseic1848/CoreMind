import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  type CoreMindConfig,
  loadConfigFile,
  loadEvaluationSuite,
  parseAndValidate,
  runEvaluationSuite,
} from "coremind-ai";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  parsePermissionMode,
} from "../approval.js";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { dim, errorLine, green, yellow } from "../render.js";

/** coremind eval：使用真实 Runtime 重复执行离线/真实 Provider 场景。 */
export async function cmdEval(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0] ?? "coremind.yaml";
  const configDir = path.dirname(path.resolve(file));
  let config: CoreMindConfig;
  try {
    config = parseAndValidate(await loadConfigFile(file)).config;
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  const permissionValue = flagString(parsed, "permission");
  const permissionMode = parsePermissionMode(permissionValue);
  if (permissionValue && !permissionMode) {
    console.error(errorLine("--permission 只能是 ask、assisted 或 full"));
    return 1;
  }
  if (permissionMode) config = applyPermissionMode(config, permissionMode);
  const approvals = new ApprovalQueue(process.stdin.isTTY === true);
  const approvalReadline =
    process.stdin.isTTY === true ? createInterface({ input, output }) : undefined;
  const unbindApprovals = approvalReadline
    ? bindReadlineApprovals(approvals, approvalReadline)
    : undefined;

  const suiteFile = path.resolve(
    flagString(parsed, "suite") ?? path.join(configDir, "evals", "scenarios.yaml"),
  );
  try {
    const result = await runEvaluationSuite({
      config,
      configDir,
      cwd: process.cwd(),
      suite: await loadEvaluationSuite(suiteFile),
      approveTool: (request) => approvals.request(request),
    });
    if (flagBool(parsed, "json")) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const passed = result.attempts.filter((attempt) => attempt.passed).length;
      for (const scenario of result.report.scenarioResults) {
        console.log(
          scenario.passed
            ? green(`✓ ${scenario.id}`)
            : errorLine(`${scenario.id}：${scenario.reason ?? "未通过"}`),
        );
      }
      console.log(dim(`运行 ${result.totalRuns} 次，通过 ${passed}/${result.totalRuns}`));
      console.log(
        result.releaseReadiness.ready
          ? green("✓ 达到评测门槛")
          : errorLine(`未达到评测门槛：${result.releaseReadiness.blockers.join("；")}`),
      );
      for (const warning of result.releaseReadiness.warnings) console.warn(yellow(`⚠ ${warning}`));
    }
    unbindApprovals?.();
    approvals.close();
    approvalReadline?.close();
    return result.releaseReadiness.ready ? 0 : 1;
  } catch (error) {
    unbindApprovals?.();
    approvals.close();
    approvalReadline?.close();
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
