import path from "node:path";
import { stdin as input, stderr as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  type ChildRunNodeProjection,
  type CoreMindConfig,
  CoreMindRuntime,
  createMcpAuthentication,
  formatMetrics,
  loadConfigFile,
  type McpAuthentication,
  parseAndValidate,
  type RunResult,
  type RunStatus,
} from "coremind-ai";
import { createBoundedOutput } from "coremind-ai/internal";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  parsePermissionMode,
} from "../approval.js";
import { flagBool, flagNumber, flagString, type ParsedArgs } from "../args.js";
import { formatObservabilityStatus } from "../observability-format.js";
import { createProjectCodeAuthorizer } from "../project-code-trust.js";
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
  const loginServer = flagString(parsed, "mcp-login");
  if (flagBool(parsed, "mcp-login") && !loginServer?.trim()) {
    console.error(errorLine("--mcp-login 需要指定已配置的服务名"));
    return 1;
  }
  if (loginServer && (process.stdin.isTTY !== true || printOnly || jsonEvents)) {
    console.error(errorLine("交互登录需要 TTY，且不能与 --print 或 --json-events 同用"));
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
  let approvalReadline: ReturnType<typeof createInterface> | undefined;
  let unbindApprovals: (() => void) | undefined;
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  let authentication: McpAuthentication | undefined;
  const writer = createBoundedOutput(process.stdout, { onFailure: () => controller.abort() });
  const log = (...values: unknown[]) => writer.write(`${values.map(String).join(" ")}\n`);
  const writeJson = (value: unknown) => {
    if (writer.failure) return;
    try {
      writer.write(`${JSON.stringify(value)}\n`);
    } catch {
      writer.fail();
    }
  };

  try {
    if (loginServer) {
      const server = config.mcp?.servers[loginServer];
      if (server?.transport !== "streamable-http" || !server.oauth) {
        console.error(errorLine("指定服务没有配置 OAuth 登录"));
        return 1;
      }
      authentication = await createMcpAuthentication({ config });
    }
    const runtime = await CoreMindRuntime.create({
      config,
      configDir,
      cwd: process.cwd(),
      initialPrompt,
      sessionId,
      resumeRunId,
      maxSteps,
      signal: controller.signal,
      approveProjectCode: createProjectCodeAuthorizer(parsed, () => controller.abort()),
      ...(authentication ? { mcpAuthentication: authentication } : {}),
      approveTool: (request) => approvals.request(request),
      events: (event) => {
        if (writer.failure) return;
        if (jsonEvents) {
          writeJson(event);
          return;
        }
        if (printOnly) return;
        renderEvent(event, (text) => writer.write(text));
      },
    });
    // 加载信任完成后才启用工具审批或 OAuth 输入，避免两个 reader 竞争 stdin。
    if (process.stdin.isTTY === true) {
      approvalReadline = createInterface({ input, output });
      unbindApprovals = bindReadlineApprovals(approvals, approvalReadline);
      approvalReadline.on("SIGINT", onSigint);
      if (loginServer) approvalReadline.on("close", onSigint);
    }
    if (loginServer && authentication) {
      const server = config.mcp!.servers[loginServer]!;
      if (server.transport !== "streamable-http" || !server.oauth)
        throw new Error("OAuth 配置无效");
      console.error(
        `登录 ${loginServer}：${server.url}；授权方 ${server.oauth.issuer}；范围 ${server.oauth.scopes.join("、")}（仅当前进程保存）`,
      );
      await authentication.login(loginServer, {
        signal: controller.signal,
        onAuthorization: (request, signal) => {
          signal.throwIfAborted();
          console.error(`请手动打开授权链接；Ctrl+C 取消：\n${request.authorizationUrl}`);
        },
      });
    }
    if (runtime.resumedContextLength > 0 && !jsonEvents && !printOnly) {
      log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
    }

    // 3. 执行
    const result = await runtime.run();
    if (printOnly && result.transcript.length > 0) {
      writer.write(result.transcript.endsWith("\n") ? result.transcript : `${result.transcript}\n`);
    }
    if (jsonEvents) {
      for (const node of result.childRuns?.nodes ?? []) {
        writeJson(toChildRunEvent(node));
      }
      writeJson(toRunResultEvent(result));
    }
    if (!printOnly && !jsonEvents) {
      log(dim(formatObservabilityStatus(result.observability)));
      if (result.childRuns) {
        for (const node of result.childRuns.nodes) {
          log(dim(formatChildRun(node)));
        }
        log(
          dim(
            `Child Runs ${result.childRuns.nodes.length} · 活动 ${result.childRuns.activeDescendants} · 未处置 ${result.childRuns.unhandledDescendants}`,
          ),
        );
      }
    }
    if (result.sessionFile && !jsonEvents && !printOnly) {
      log(dim(`会话已保存：${result.sessionFile}`));
    }
    // 质量摘要（管道/机器模式不打印，保持 --print/--json-events 纯净）
    if (!printOnly && !jsonEvents && result.outcome.status === "succeeded") {
      log(dim(`✓ 运行完成：${formatMetrics(result.metrics)}`));
    }
    if (result.outcome.status !== "succeeded") {
      const diagnostic =
        result.outcome.error?.message ??
        `运行以 ${result.outcome.status} 结束：${result.outcome.finishReason}`;
      console.error(errorLine(diagnostic));
    }
    await writer.flush();
    return exitCodeForRunStatus(result.outcome.status);
  } catch (error) {
    try {
      await writer.flush();
    } catch {
      /* 优先报告锁存的交付失败。 */
    }
    if (writer.failure) {
      console.error(errorLine(`output_delivery_failed: ${writer.failure.message}`));
      return 1;
    }
    if (
      controller.signal.aborted ||
      (error && typeof error === "object" && "code" in error && error.code === "aborted")
    ) {
      console.error(errorLine("运行已取消"));
      return RUN_EXIT_CODES.aborted;
    }
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    process.off("SIGINT", onSigint);
    approvalReadline?.off("SIGINT", onSigint);
    approvalReadline?.off("close", onSigint);
    unbindApprovals?.();
    approvals.close();
    approvalReadline?.close();
    try {
      await authentication?.close();
    } finally {
      await writer.close();
    }
  }
}

/** 将持久化 Child Run 投影压缩为稳定、可读的一行摘要。 */
function formatChildRun(node: ChildRunNodeProjection): string {
  const result = node.result;
  const outcome = node.outcome
    ? `${node.outcome.status} (${node.outcome.finishReason})`
    : "等待结果";
  const resultSummary = result
    ? ` · 证据 ${result.evidence.length} · 产物 ${result.artifacts.length} · 未决风险 ${result.unresolvedRisks.length}`
    : "";
  return `Child Run ${node.childRunId} · 目标 ${node.agentName} · 状态 ${node.status} · 结果 ${outcome}${resultSummary}`;
}

/** JSONL 中由规范 Child Run 投影派生的稳定生命周期摘要。 */
function toChildRunEvent(node: ChildRunNodeProjection): Record<string, unknown> {
  return {
    type: "child_run",
    version: 1,
    parentRunId: node.parentRunId,
    childRunId: node.childRunId,
    delegationId: node.delegationId,
    target: node.agentName,
    status: node.status,
    ...(node.outcome ? { outcome: node.outcome } : {}),
    ...(node.recovery ? { recovery: node.recovery } : {}),
  };
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
  write: (text: string) => void,
): void {
  switch (event.type) {
    case "text_delta":
      write(event.delta);
      break;
    case "loop_state":
      write(`\n${loopStateLine(event.to, event.iteration, event.repairs)}\n`);
      break;
    case "step_start":
      write(`\n${stepLine(event.stepId, event.kind)}\n`);
      break;
    case "step_resumed":
      write(`\n${dim(`↻ 复用稳定步骤：${event.stepId}`)}\n`);
      break;
    case "tool_call":
      write(`\n${toolLine(event.tool, event.args)}`);
      break;
    case "tool_result":
      write(toolResultLine(event.isError));
      break;
    case "agent_start":
      write(`\n${cyan(`[${event.agent}]`)} `);
      break;
    case "agent_end":
      write("\n");
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
