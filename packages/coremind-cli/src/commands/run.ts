import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  type CoreMindConfig,
  CoreMindRuntime,
  formatMetrics,
  loadConfigFile,
  parseAndValidate,
  type RunResult,
  type RunStatus,
} from "coremind-ai";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  parsePermissionMode,
} from "../approval.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { formatObservabilityStatus } from "../observability-format.js";
import {
  cyan,
  dim,
  errorLine,
  loopStateLine,
  stepLine,
  toolLine,
  toolResultLine,
  yellow,
} from "../render.js";

/**
 * coremind run <file>：校验配置 → 构建运行时 → 执行。
 * 支持 --prompt / --print / --json-events / --session / --resume / --max-steps。
 */
export async function cmdRun(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) {
    console.error(errorLine("请指定配置文件路径，如：coremind run coremind.yaml"));
    return 1;
  }

  // 1. 读取并校验配置
  let data: unknown;
  try {
    data = await loadConfigFile(file);
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  let config: CoreMindConfig;
  try {
    const result = parseAndValidate(data);
    config = result.config;
    for (const warning of result.warnings) console.warn(yellow(`⚠ ${warning}`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const permissionValue = flagString(parsed, "permission");
  const permissionMode = parsePermissionMode(permissionValue);
  if (permissionValue && !permissionMode) {
    console.error(errorLine("--permission 只能是 ask、assisted 或 full"));
    return 1;
  }
  if (permissionMode) config = applyPermissionMode(config, permissionMode);

  const printOnly = flagBool(parsed, "print");
  const jsonEvents = flagBool(parsed, "json-events");
  if (printOnly && jsonEvents) {
    console.error(errorLine("--print 与 --json-events 不能同时使用"));
    return 1;
  }
  const initialPrompt = flagString(parsed, "prompt") ?? flagString(parsed, "p");
  const sessionId = flagString(parsed, "session");
  if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    console.error(errorLine(`会话 id 只能包含字母、数字、连字符与下划线：${sessionId}`));
    return 1;
  }
  if (sessionId && config.session?.enabled !== true) {
    console.error(errorLine("使用 --session 前请在 coremind.yaml 中设置 session.enabled: true"));
    return 1;
  }
  const resumeRunId = flagString(parsed, "resume");
  if (resumeRunId && !/^[a-zA-Z0-9_-]+$/.test(resumeRunId)) {
    console.error(errorLine(`runId 只能包含字母、数字、连字符与下划线：${resumeRunId}`));
    return 1;
  }
  const maxSteps = flagNumber(parsed, "max-steps");
  const configDir = path.dirname(path.resolve(file));

  // 2. 构建运行时（事件回调：JSONL 或渲染）
  const controller = new AbortController();
  const approvals = new ApprovalQueue(process.stdin.isTTY === true);
  const approvalReadline =
    process.stdin.isTTY === true ? createInterface({ input, output }) : undefined;
  const unbindApprovals = approvalReadline
    ? bindReadlineApprovals(approvals, approvalReadline)
    : undefined;
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);

  try {
    const runtime = await CoreMindRuntime.create({
      config,
      configDir,
      cwd: process.cwd(),
      initialPrompt,
      sessionId,
      resumeRunId,
      maxSteps,
      signal: controller.signal,
      approveTool: (request) => approvals.request(request),
      events: (event) => {
        if (jsonEvents) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
          return;
        }
        if (printOnly && event.type === "text_delta") return;
        renderEvent(event);
      },
    });
    if (runtime.resumedContextLength > 0 && !jsonEvents) {
      console.log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
    }

    // 3. 执行
    const result = await runtime.run();
    if (printOnly && result.transcript.length > 0) {
      process.stdout.write(
        result.transcript.endsWith("\n") ? result.transcript : `${result.transcript}\n`,
      );
    }
    if (jsonEvents) {
      process.stdout.write(`${JSON.stringify(toRunResultEvent(result))}\n`);
    }
    if (!printOnly && !jsonEvents) {
      console.log(dim(formatObservabilityStatus(result.observability)));
      if (result.childRuns) {
        console.log(
          dim(
            `Child Runs ${result.childRuns.nodes.length} · 活动 ${result.childRuns.activeDescendants} · 未处置 ${result.childRuns.unhandledDescendants}`,
          ),
        );
      }
    }
    if (result.sessionFile && !jsonEvents) {
      console.log(dim(`会话已保存：${result.sessionFile}`));
    }
    // 质量摘要（管道/机器模式不打印，保持 --print/--json-events 纯净）
    if (!printOnly && !jsonEvents && result.outcome.status === "succeeded") {
      console.log(dim(`✓ 运行完成：${formatMetrics(result.metrics)}`));
    }
    if (result.outcome.status !== "succeeded") {
      const diagnostic =
        result.outcome.error?.message ??
        `运行以 ${result.outcome.status} 结束：${result.outcome.finishReason}`;
      console.error(errorLine(diagnostic));
    }
    return exitCodeForRunStatus(result.outcome.status);
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    unbindApprovals?.();
    approvals.close();
    approvalReadline?.close();
  }
}

export const RUN_EXIT_CODES: Readonly<Record<RunStatus, number>> = {
  succeeded: 0,
  failed: 1,
  paused: 2,
  budget_exceeded: 3,
  timeout: 124,
  aborted: 130,
};

/** CLI 与自动化脚本共同依赖的稳定退出码映射。 */
export function exitCodeForRunStatus(status: RunStatus): number {
  return RUN_EXIT_CODES[status];
}

/** JSONL 的最后一行；不序列化 Map 等仅供进程内使用的数据。 */
export function toRunResultEvent(result: RunResult): Record<string, unknown> {
  return {
    type: "run_result",
    version: 1,
    snapshot: result.snapshot,
    runId: result.runId,
    operation: result.operation,
    outcome: result.outcome,
    metrics: result.metrics,
    evaluation: result.evaluation,
    releaseReadiness: result.releaseReadiness,
    observability: result.observability,
    ...(result.childRuns ? { childRuns: result.childRuns } : {}),
    checkpoints: result.checkpoints,
    ...(result.runStateFile ? { runStateFile: result.runStateFile } : {}),
    ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
  };
}

/** 默认模式的事件渲染（流式文本 + 步骤 + 工具调用） */
function renderEvent(
  event: Parameters<NonNullable<Parameters<typeof CoreMindRuntime.create>[0]["events"]>>[0],
): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "loop_state":
      process.stdout.write(`\n${loopStateLine(event.to, event.iteration, event.repairs)}\n`);
      break;
    case "step_start":
      process.stdout.write(`\n${stepLine(event.stepId, event.kind)}\n`);
      break;
    case "step_resumed":
      process.stdout.write(`\n${dim(`↻ 复用稳定步骤：${event.stepId}`)}\n`);
      break;
    case "tool_call":
      process.stdout.write(`\n${toolLine(event.tool, event.args)}`);
      break;
    case "tool_result":
      process.stdout.write(toolResultLine(event.isError));
      break;
    case "agent_start":
      process.stdout.write(`\n${cyan(`[${event.agent}]`)} `);
      break;
    case "agent_end":
      process.stdout.write("\n");
      break;
    case "error":
      if (event.fatal) {
        console.error(errorLine(event.message));
      } else {
        console.warn(yellow(`⚠ ${event.message}`));
      }
      break;
  }
}
