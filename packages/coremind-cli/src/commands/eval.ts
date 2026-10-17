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
import { createProjectCodeAuthorizer } from "../project-code-trust.js";
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
  const controller = new AbortController();
  let approvalReadline: ReturnType<typeof createInterface> | undefined;
  let unbindApprovals: (() => void) | undefined;

  const suiteFile = path.resolve(
    flagString(parsed, "suite") ?? path.join(configDir, "evals", "scenarios.yaml"),
  );
  try {
    const authorize = createProjectCodeAuthorizer(parsed, () => controller.abort());
    const result = await runEvaluationSuite({
      config,
      configDir,
      cwd: process.cwd(),
      signal: controller.signal,
      suite: await loadEvaluationSuite(suiteFile),
      approveProjectCode: async (request, signal) => {
        // 每次初始化先关闭上一场景的审批输入；同范围决定由 authorizer 复用。
        unbindApprovals?.();
        unbindApprovals = undefined;
        approvalReadline?.close();
        approvalReadline = undefined;
        return authorize(request, signal);
      },
      approveTool: (request) => {
        if (!approvalReadline && process.stdin.isTTY === true) {
          approvalReadline = createInterface({ input, output });
          unbindApprovals = bindReadlineApprovals(approvals, approvalReadline);
        }
        return approvals.request(request);
      },
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
    if (
      controller.signal.aborted ||
      (error && typeof error === "object" && "code" in error && error.code === "aborted")
    ) {
      console.error(errorLine("评测已取消"));
      return 130;
    }
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
}
