import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  ChatSession,
  type CoreMindConfig,
  type CoreMindEvent,
  CoreMindRuntime,
  createMcpAuthentication,
  loadConfigFile,
  type McpAuthentication,
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
import { formatMcpAuthenticationError, type McpChatAuthentication, runChatTUI } from "../tui.js";

function printChatHelp(): void {
  console.log(dim("命令："));
  console.log(dim("  /help            显示本帮助"));
  console.log(dim("  /exit            退出对话"));
  console.log(dim("  /abort           中止当前回答（可继续提问）"));
  console.log(dim("  /steer 文本      向当前运行追加指令"));
  console.log(dim("  /follow-up 文本  当前任务自然结束后继续输入"));
  console.log(dim("  /mcp login 服务  登录已配置的 MCP 服务（仅当前进程保存）"));
  console.log(dim("  /mcp cancel      取消当前登录"));
  console.log(dim("  /mcp logout 服务 清除当前进程的服务凭据"));
  console.log(dim("忙时普通输入仅保留为草稿，空闲后按 Enter 确认发送。"));
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
  let authentication: McpAuthentication | undefined;
  try {
    if (
      Object.values(config.mcp?.servers ?? {}).some(
        (server) => server.transport === "streamable-http" && server.oauth,
      )
    )
      authentication = await createMcpAuthentication({ config });
    const mcp = authentication ? { authentication, config } : undefined;
    const runtime = await CoreMindRuntime.create({
      config,
      configDir,
      cwd: process.cwd(),
      sessionId,
      ...(authentication ? { mcpAuthentication: authentication } : {}),
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
      await runChatTUI(session, config.name, approvals, mcp);
    } else {
      if (!quiet) console.log(dim(`开始对话（/help 查看命令，/exit 退出）—— ${config.name}`));
      const unsubscribe = session.onEvent(renderChatEvent);
      try {
        await runReadlineChat(session, approvals, undefined, mcp);
      } finally {
        unsubscribe();
      }
    }
    const sessionFile = await session.persist();
    if (sessionFile) console.log(dim(`会话已保存：${sessionFile}`));
    return 0;
  } finally {
    approvals.close();
    await authentication?.close();
  }
}

/** readline 模式（非交互终端回退）：单行输入 + 流式输出 + 工具行 */
export async function runReadlineChat(
  session: ChatSession,
  approvals: ApprovalQueue,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input, output },
  mcp?: McpChatAuthentication,
): Promise<void> {
  const rl = createInterface(streams);
  let answerApproval: ((answer: string) => void) | undefined;
  let activeChat: Promise<void> | undefined;
  let draft: string | undefined;
  let draftPrefilled = false;
  const terminal = "isTTY" in streams.input && streams.input.isTTY === true;
  const controls = new Set<Promise<void>>();
  let login: { controller: AbortController; operation: Promise<void> } | undefined;
  const cancelLogin = () => login?.controller.abort();
  const onSigint = () => {
    cancelLogin();
    session.abort();
    rl.close();
  };
  if (mcp) {
    process.on("SIGINT", onSigint);
    rl.on("SIGINT", onSigint);
  }
  const unbindApprovals = bindReadlineApprovals(approvals, {
    question: (prompt) => {
      streams.output.write(prompt);
      return new Promise<string>((resolve) => {
        answerApproval = resolve;
      });
    },
  });
  try {
    streams.output.write(cyan("\n你 > "));
    for await (const line of rl) {
      const text = line.trim();
      const editedDraft = draftPrefilled;
      draftPrefilled = false;
      if (text === "/exit" || text === "!exit") break;
      if (/^\/mcp(?:\s|$)/u.test(text)) {
        const command = /^\/mcp\s+(login|logout)\s+(\S+)$/u.exec(text);
        if (text === "/mcp cancel") {
          cancelLogin();
          streams.output.write("已请求取消登录\n");
          continue;
        }
        if (!command) {
          streams.output.write("用法：/mcp login 服务、/mcp cancel、/mcp logout 服务\n");
          continue;
        }
        const serverName = command[2]!;
        const server = mcp?.config.mcp?.servers[serverName];
        if (!mcp || server?.transport !== "streamable-http" || !server.oauth) {
          streams.output.write("指定服务没有配置 OAuth 登录\n");
          continue;
        }
        if (command[1] === "logout") {
          cancelLogin();
          const operation = mcp.authentication.logout(serverName).then(
            () => {
              streams.output.write("已清除当前进程的服务凭据\n");
            },
            (error: unknown) => {
              streams.output.write(`${formatMcpAuthenticationError(error)}\n`);
            },
          );
          controls.add(operation);
          void operation.finally(() => controls.delete(operation));
          continue;
        }
        if (!terminal) {
          streams.output.write("交互登录需要 TTY\n");
          continue;
        }
        if (login || activeChat || answerApproval) {
          streams.output.write("请等待当前运行、审批或登录结束后再登录\n");
          continue;
        }
        streams.output.write(
          `登录 ${serverName}：${server.url}；授权方 ${server.oauth.issuer}；范围 ${server.oauth.scopes.join("、")}（仅当前进程保存）\n`,
        );
        const controller = new AbortController();
        const operation = mcp.authentication
          .login(serverName, {
            signal: controller.signal,
            onAuthorization: (request, signal) => {
              signal.throwIfAborted();
              streams.output.write(
                `请手动打开授权链接；/mcp cancel 取消：\n${request.authorizationUrl}\n`,
              );
            },
          })
          .then(
            () => {
              streams.output.write("登录成功，可继续提问\n");
            },
            (error: unknown) => {
              streams.output.write(`${formatMcpAuthenticationError(error)}\n`);
            },
          )
          .finally(() => {
            if (login?.controller === controller) login = undefined;
          });
        login = { controller, operation };
        continue;
      }
      if (text === "/abort" || text === "!abort") {
        session.abort();
        while (approvals.current) approvals.resolve("deny");
        answerApproval?.("n");
        answerApproval = undefined;
        streams.output.write(dim("已请求中止，收尾后可继续提问\n"));
        continue;
      }
      const control = /^\/(steer|follow-up)(?:\s+([\s\S]*))?$/u.exec(text);
      if (control) {
        const message = control[2]?.trim();
        if (!message) {
          streams.output.write(`用法：/${control[1]} 文本\n`);
          continue;
        }
        // 调用时立即固定活动 Run；仅等待回执的部分并发，不占用输入循环。
        const operation = (async () => {
          try {
            const receipt = await (control[1] === "steer"
              ? session.steer(message)
              : session.followUp(message));
            streams.output.write(
              `控制 ${receipt.controlId} · Run ${receipt.runId} · ${receipt.status}${receipt.duplicateOf ? ` (${receipt.duplicateOf})` : ""}${receipt.reason ? `：${receipt.reason}` : ""}\n`,
            );
          } catch (error) {
            streams.output.write(
              `控制失败：${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
        })();
        controls.add(operation);
        void operation.finally(() => controls.delete(operation));
        continue;
      }
      if (text === "/help" || (answerApproval && text.startsWith("/"))) {
        if (text === "/help") printChatHelp();
        else streams.output.write(`未知命令：${text}\n`);
        continue;
      }
      if (answerApproval) {
        const answer = answerApproval;
        answerApproval = undefined;
        answer(text);
        continue;
      }
      if (login) {
        streams.output.write("登录等待中；使用 /mcp cancel 取消，或 /exit 退出\n");
        continue;
      }
      if (activeChat) {
        if (!text) continue;
        if (draft === undefined) {
          draft = text;
          streams.output.write(
            `草稿已保留：${draft}\n空闲后按 Enter 确认发送；当前可用 /steer、/follow-up 或 /abort。\n`,
          );
        } else {
          streams.output.write(`已有草稿，未替换：${draft}\n本次输入未保存：${text}\n`);
        }
        continue;
      }
      if (!text && draft === undefined) continue;
      if (draft !== undefined && text && !editedDraft) {
        streams.output.write(
          `已有草稿，未替换：${draft}\n本次输入未保存：${text}\n空行确认发送原草稿。\n`,
        );
        continue;
      }
      const message = editedDraft ? text : (draft ?? text);
      draft = undefined;
      if (!message) continue;
      streams.output.write(dim("[assistant] "));
      activeChat = Promise.resolve()
        .then(() => session.chat(message))
        .then(() => {
          streams.output.write("\n");
        })
        .catch((error: unknown) => {
          console.error(errorLine(error instanceof Error ? error.message : String(error)));
        })
        .finally(() => {
          activeChat = undefined;
          streams.output.write(cyan("\n你 > "));
          if (draft !== undefined) {
            streams.output.write(`草稿待确认：${draft}\n按 Enter 发送草稿。\n`);
            if (terminal && !rl.line) {
              rl.write(draft);
              draftPrefilled = true;
            }
          }
        });
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.off("SIGINT", onSigint);
    cancelLogin();
    unbindApprovals();
    answerApproval?.("n");
    approvals.close();
    await login?.operation;
    await activeChat;
    await Promise.allSettled(controls);
    rl.close();
  }
}

/** 对话事件渲染（工具调用可视化 + 流式文本） */
export function renderChatEvent(
  event: CoreMindEvent,
  stream: NodeJS.WritableStream = output,
): void {
  switch (event.type) {
    case "text_delta":
      stream.write(event.delta);
      break;
    case "tool_call":
      stream.write(`\n${toolLine(event.tool, event.args)}`);
      break;
    case "tool_result":
      stream.write(` ${toolResultLine(event.isError)}`);
      break;
    case "loop_state":
      stream.write(`\n${loopStateLine(event.to, event.iteration, event.repairs)}\n`);
      break;
    case "input_receipt":
    case "input_claimed":
    case "input_completed":
    case "input_discarded":
      stream.write(
        `\n输入 ${event.inputId} · ${event.status}${event.type === "input_claimed" ? ` · Turn ${event.turnId}` : ""}\n`,
      );
      break;
    default:
      break;
  }
}
