import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { ChatSession, type CoreMindEvent, CoreMindRuntime } from "coremind-ai";
import { type CoreMindConfig, loadConfigFile, parseAndValidate } from "coremind-config";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { cyan, dim, errorLine, toolLine, toolResultLine, yellow } from "../render.js";
import { runChatTUI } from "../tui.js";

function printChatHelp(): void {
  console.log(dim("命令："));
  console.log(dim("  /help            显示本帮助"));
  console.log(dim("  /exit            退出对话"));
  console.log(dim("  /abort           中止当前回答（可继续提问）"));
}

/**
 * coremind chat <file>：交互式对话（复用同一 agent 实例，多轮上下文）。
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

  const configDir = path.dirname(path.resolve(file));
  const sessionId = flagString(parsed, "session");
  if (sessionId && !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
    console.error(errorLine(`会话 id 只能包含字母、数字、连字符与下划线：${sessionId}`));
    return 1;
  }
  const runtime = await CoreMindRuntime.create({
    config,
    configDir,
    cwd: process.cwd(),
    sessionId,
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
  // 对话事件渲染：流式文本 + 工具调用实时展示
  session.onEvent(renderChatEvent);
  if (runtime.resumedContextLength > 0) {
    console.log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
  }

  const quiet = flagBool(parsed, "quiet");
  // 交互终端（TTY）默认全屏 TUI；非 TTY（管道/脚本）或 --no-tui 回退 readline
  if (process.stdin.isTTY === true && !flagBool(parsed, "no-tui")) {
    await runChatTUI(session, config.name);
  } else {
    if (!quiet) console.log(dim(`开始对话（/help 查看命令，/exit 退出）—— ${config.name}`));
    await runReadlineChat(session);
  }
  const sessionFile = await session.persist();
  if (sessionFile) console.log(dim(`会话已保存：${sessionFile}`));
  return 0;
}

/** readline 模式（非交互终端回退）：单行输入 + 流式输出 + 工具行 */
async function runReadlineChat(session: ChatSession): Promise<void> {
  const rl = createInterface({ input, output });
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
    default:
      break;
  }
}
