import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  ChatSession,
  type CoreMindConfig,
  type CoreMindEvent,
  CoreMindRuntime,
  loadConfigFile,
  parseAndValidate,
} from "coremind-ai";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  parsePermissionMode,
} from "../approval.js";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import {
  cyan,
  dim,
  errorLine,
  loopStateLine,
  toolLine,
  toolResultLine,
  yellow,
} from "../render.js";
import { runChatTUI } from "../tui.js";

function printChatHelp(): void {
  console.log(dim("命令："));
  console.log(dim("  /help            显示本帮助"));
  console.log(dim("  /exit            退出对话"));
  console.log(dim("  /abort           中止当前回答（可继续提问）"));
}

/**
 * coremind chat <file>：交互式对话（复用同一会话上下文，每轮进入完整 Harness）。
 * 支持 /help /exit /abort 命令与工具调用实时展示；退出时保存会话。
 */
export async function cmdChat(parsed: ParsedArgs, positionals: string[]): Promise<number> {
  const file = positionals[0];
  if (!file) {
    console.error(errorLine("请指定配置文件路径，如：coremind chat coremind.yaml"));
    return 1;
  }

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

  const configDir = path.dirname(path.resolve(file));
  const sessionId = flagString(parsed, "session");
  if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    console.error(errorLine(`会话 id 只能包含字母、数字、连字符与下划线：${sessionId}`));
    return 1;
  }
  if (sessionId && config.session?.enabled !== true) {
    console.error(errorLine("使用 --session 前请在 coremind.yaml 中设置 session.enabled: true"));
    return 1;
  }
  const approvals = new ApprovalQueue(process.stdin.isTTY === true);
  const runtime = await CoreMindRuntime.create({
    config,
    configDir,
    cwd: process.cwd(),
    sessionId,
    approveTool: (request) => approvals.request(request),
    // 非对话事件（配置告警等）由 runtime 回调处理；对话事件走 ChatSession
    events: (event) => {
      if (event.type === "error" && !event.fatal) console.warn(yellow(`⚠ ${event.message}`));
    },
  });

  const agentName = config.defaultAgent ?? Object.keys(config.agents)[0];
  let session: ChatSession;
  try {
    session = new ChatSession(runtime, agentName ?? "");
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  }
  if (runtime.resumedContextLength > 0) {
    console.log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
  }

  const quiet = flagBool(parsed, "quiet");
  // 交互终端（TTY）默认全屏 TUI；非 TTY（管道/脚本）或 --no-tui 回退 readline
  if (process.stdin.isTTY === true && !flagBool(parsed, "no-tui")) {
    await runChatTUI(session, config.name, approvals);
  } else {
    if (!quiet) console.log(dim(`开始对话（/help 查看命令，/exit 退出）—— ${config.name}`));
    const unsubscribe = session.onEvent(renderChatEvent);
    try {
      await runReadlineChat(session, approvals);
    } finally {
      unsubscribe();
    }
  }
  const sessionFile = await session.persist();
  if (sessionFile) console.log(dim(`会话已保存：${sessionFile}`));
  approvals.close();
  return 0;
}

/** readline 模式（非交互终端回退）：单行输入 + 流式输出 + 工具行 */
async function runReadlineChat(session: ChatSession, approvals: ApprovalQueue): Promise<void> {
  const rl = createInterface({ input, output });
  const unbindApprovals = bindReadlineApprovals(approvals, rl);
  try {
    while (true) {
      const line = await rl.question(cyan("\n你 > "));
      const text = line.trim();
      if (text === "") continue;
      if (text === "/exit" || text === "!exit") break;
      if (text === "/abort" || text === "!abort") {
        session.abort();
        console.log(dim("已中止，可继续提问"));
        continue;
      }
      if (text === "/help") {
        printChatHelp();
        continue;
      }
      process.stdout.write(`${dim("[assistant] ")}`);
      await session.chat(text);
      process.stdout.write("\n");
    }
  } catch (error) {
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
  } finally {
    unbindApprovals();
    rl.close();
  }
}

/** 对话事件渲染（工具调用可视化 + 流式文本） */
function renderChatEvent(event: CoreMindEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.delta);
      break;
    case "tool_call":
      process.stdout.write(`\n${toolLine(event.tool, event.args)}`);
      break;
    case "tool_result":
      process.stdout.write(` ${toolResultLine(event.isError)}`);
      break;
    case "loop_state":
      process.stdout.write(`\n${loopStateLine(event.to, event.iteration, event.repairs)}\n`);
      break;
    default:
      break;
  }
}
