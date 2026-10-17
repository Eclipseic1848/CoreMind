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
import { type BoundedOutput, createBoundedOutput } from "coremind-ai/internal";
import {
  ApprovalQueue,
  applyPermissionMode,
  bindReadlineApprovals,
  parsePermissionMode,
} from "../approval.js";
import { flagBool, flagString, type ParsedArgs } from "../args.js";
import { createProjectCodeAuthorizer } from "../project-code-trust.js";
import {
  cyan,
  dim,
  errorLine,
  formatTerminalRow,
  loopStateLine,
  terminalText,
  yellow,
} from "../render.js";
import { createTerminalView, foldTerminalView } from "../terminal-view.js";
import { formatMcpAuthenticationError, type McpChatAuthentication, runChatTUI } from "../tui.js";

function printChatHelp(write: (text: string) => void): void {
  const log = (text: string) => write(`${text}\n`);
  log(dim("命令："));
  log(dim("  /help            显示本帮助"));
  log(dim("  /exit            退出对话"));
  log(dim("  /abort           中止当前回答（可继续提问）"));
  log(dim("  /steer 文本      向当前运行追加指令"));
  log(dim("  /follow-up 文本  当前任务自然结束后继续输入"));
  log(dim("  /mcp login 服务  登录已配置的 MCP 服务（仅当前进程保存）"));
  log(dim("  /mcp cancel      取消当前登录"));
  log(dim("  /mcp logout 服务 清除当前进程的服务凭据"));
  log(dim("忙时普通输入仅保留为草稿，空闲后按 Enter 确认发送。"));
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
  let session: ChatSession | undefined;
  const useTui = process.stdin.isTTY === true && !flagBool(parsed, "no-tui");
  const controller = new AbortController();
  const writer = useTui
    ? undefined
    : createBoundedOutput(output, {
        onFailure: () => controller.abort(),
      });
  const log = (text: string) => (writer ? writer.write(`${text}\n`) : console.log(text));
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
      signal: controller.signal,
      approveProjectCode: createProjectCodeAuthorizer(parsed, () => controller.abort()),
      ...(authentication ? { mcpAuthentication: authentication } : {}),
      approveTool: (request) => approvals.request(request),
      // 非对话事件（配置告警等）由 runtime 回调处理；对话事件走 ChatSession
      events: (event) => {
        if (event.type === "error" && !event.fatal) console.warn(yellow(`⚠ ${event.message}`));
      },
    });

    const agentName = config.defaultAgent ?? Object.keys(config.agents)[0];
    try {
      session = new ChatSession(runtime, agentName ?? "");
    } catch (error) {
      console.error(errorLine(error instanceof Error ? error.message : String(error)));
      return 1;
    }
    if (runtime.resumedContextLength > 0) {
      log(dim(`已恢复会话 ${sessionId}（${runtime.resumedContextLength} 条历史消息）`));
    }

    const quiet = flagBool(parsed, "quiet");
    // 交互终端（TTY）默认全屏 TUI；非 TTY（管道/脚本）或 --no-tui 回退 readline
    if (useTui) {
      await runChatTUI(session, config.name, approvals, mcp);
    } else {
      if (!quiet) log(dim(`开始对话（/help 查看命令，/exit 退出）—— ${config.name}`));
      const unsubscribe = session.onEvent((event, entry) => {
        if (!writer!.failure) renderChatEvent(event, writer!, entry?.runId);
      });
      try {
        await runReadlineChat(session, approvals, undefined, mcp, {
          writer: writer!,
          signal: controller.signal,
        });
      } finally {
        unsubscribe();
      }
    }
    const sessionFile = await session.persist();
    if (sessionFile) log(dim(`会话已保存：${sessionFile}`));
    await writer?.flush();
    return 0;
  } catch (error) {
    if (writer?.failure) {
      console.error(errorLine(`output_delivery_failed: ${writer.failure.message}`));
      return 1;
    }
    if (
      controller.signal.aborted ||
      (error && typeof error === "object" && "code" in error && error.code === "aborted")
    ) {
      console.error(errorLine("运行已取消"));
      return 130;
    }
    console.error(errorLine(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    approvals.close();
    try {
      await authentication?.close();
    } finally {
      await writer?.close();
    }
  }
}

/** readline 模式（非交互终端回退）：单行输入 + 流式输出 + 工具行 */
export async function runReadlineChat(
  session: ChatSession,
  approvals: ApprovalQueue,
  streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input, output },
  mcp?: McpChatAuthentication,
  delivery?: { writer: BoundedOutput; signal: AbortSignal },
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
  const stopOutput = () => {
    cancelLogin();
    session.abort();
    while (approvals.current) approvals.resolve("deny");
    answerApproval?.("n");
    answerApproval = undefined;
    rl.close();
  };
  const writer = delivery?.writer ?? createBoundedOutput(streams.output, { onFailure: stopOutput });
  delivery?.signal.addEventListener("abort", stopOutput, { once: true });
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
    question: (prompt) =>
      new Promise<string>((resolve) => {
        answerApproval = resolve;
        writer.write(prompt);
        if (writer.failure) {
          answerApproval = undefined;
          resolve("n");
        }
      }),
  });
  try {
    if (delivery?.signal.aborted) stopOutput();
    writer.write(cyan("\n你 > "));
    for await (const line of rl) {
      if (writer.failure) break;
      const text = line.trim();
      const editedDraft = draftPrefilled;
      draftPrefilled = false;
      if (text === "/exit" || text === "!exit") break;
      if (/^\/mcp(?:\s|$)/u.test(text)) {
        const command = /^\/mcp\s+(login|logout)\s+(\S+)$/u.exec(text);
        if (text === "/mcp cancel") {
          cancelLogin();
          writer.write("已请求取消登录\n");
          continue;
        }
        if (!command) {
          writer.write("用法：/mcp login 服务、/mcp cancel、/mcp logout 服务\n");
          continue;
        }
        const serverName = command[2]!;
        const server = mcp?.config.mcp?.servers[serverName];
        if (!mcp || server?.transport !== "streamable-http" || !server.oauth) {
          writer.write("指定服务没有配置 OAuth 登录\n");
          continue;
        }
        if (command[1] === "logout") {
          cancelLogin();
          const operation = mcp.authentication.logout(serverName).then(
            () => {
              writer.write("已清除当前进程的服务凭据\n");
            },
            (error: unknown) => {
              writer.write(`${formatMcpAuthenticationError(error)}\n`);
            },
          );
          controls.add(operation);
          void operation.finally(() => controls.delete(operation));
          continue;
        }
        if (!terminal) {
          writer.write("交互登录需要 TTY\n");
          continue;
        }
        if (login || activeChat || answerApproval) {
          writer.write("请等待当前运行、审批或登录结束后再登录\n");
          continue;
        }
        writer.write(
          `登录 ${serverName}：${server.url}；授权方 ${server.oauth.issuer}；范围 ${server.oauth.scopes.join("、")}（仅当前进程保存）\n`,
        );
        const controller = new AbortController();
        const operation = mcp.authentication
          .login(serverName, {
            signal: controller.signal,
            onAuthorization: (request, signal) => {
              signal.throwIfAborted();
              writer.write(`请手动打开授权链接；/mcp cancel 取消：\n${request.authorizationUrl}\n`);
            },
          })
          .then(
            () => {
              writer.write("登录成功，可继续提问\n");
            },
            (error: unknown) => {
              writer.write(`${formatMcpAuthenticationError(error)}\n`);
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
        writer.write(dim("已请求中止，收尾后可继续提问\n"));
        continue;
      }
      const control = /^\/(steer|follow-up)(?:\s+([\s\S]*))?$/u.exec(text);
      if (control) {
        const message = control[2]?.trim();
        if (!message) {
          writer.write(`用法：/${control[1]} 文本\n`);
          continue;
        }
        // 调用时立即固定活动 Run；仅等待回执的部分并发，不占用输入循环。
        const operation = (async () => {
          try {
            const receipt = await (control[1] === "steer"
              ? session.steer(message)
              : session.followUp(message));
            writer.write(
              `控制 ${receipt.controlId} · Run ${receipt.runId} · ${receipt.status}${receipt.duplicateOf ? ` (${receipt.duplicateOf})` : ""}${receipt.reason ? `：${receipt.reason}` : ""}\n`,
            );
          } catch (error) {
            writer.write(`控制失败：${error instanceof Error ? error.message : String(error)}\n`);
          }
        })();
        controls.add(operation);
        void operation.finally(() => controls.delete(operation));
        continue;
      }
      if (text === "/help" || (answerApproval && text.startsWith("/"))) {
        if (text === "/help") printChatHelp((text) => writer.write(text));
        else writer.write(`未知命令：${text}\n`);
        continue;
      }
      if (answerApproval) {
        const answer = answerApproval;
        answerApproval = undefined;
        answer(text);
        continue;
      }
      if (login) {
        writer.write("登录等待中；使用 /mcp cancel 取消，或 /exit 退出\n");
        continue;
      }
      if (activeChat) {
        if (!text) continue;
        if (draft === undefined) {
          draft = text;
          writer.write(
            `草稿已保留：${draft}\n空闲后按 Enter 确认发送；当前可用 /steer、/follow-up 或 /abort。\n`,
          );
        } else {
          writer.write(`已有草稿，未替换：${draft}\n本次输入未保存：${text}\n`);
        }
        continue;
      }
      if (!text && draft === undefined) continue;
      if (draft !== undefined && text && !editedDraft) {
        writer.write(`已有草稿，未替换：${draft}\n本次输入未保存：${text}\n空行确认发送原草稿。\n`);
        continue;
      }
      const message = editedDraft ? text : (draft ?? text);
      draft = undefined;
      if (!message) continue;
      writer.write(dim("[assistant] "));
      activeChat = Promise.resolve()
        .then(() => (writer.failure ? undefined : session.chat(message)))
        .then(() => {
          writer.write("\n");
        })
        .catch((error: unknown) => {
          console.error(errorLine(error instanceof Error ? error.message : String(error)));
        })
        .finally(() => {
          activeChat = undefined;
          writer.write(cyan("\n你 > "));
          if (!writer.failure && draft !== undefined) {
            writer.write(`草稿待确认：${draft}\n按 Enter 发送草稿。\n`);
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
    delivery?.signal.removeEventListener("abort", stopOutput);
    rl.close();
    if (!delivery) {
      try {
        await writer.flush();
      } finally {
        await writer.close();
      }
    }
  }
  if (writer.failure) throw writer.failure;
}

/** 对话事件渲染（工具调用可视化 + 流式文本） */
export function renderChatEvent(
  event: CoreMindEvent,
  stream: { write(text: string): unknown } = output,
  runId?: string,
): void {
  switch (event.type) {
    case "text_delta":
      stream.write(terminalText(event.delta));
      break;
    case "loop_state":
      stream.write(`\n${loopStateLine(event.to, event.iteration, event.repairs)}\n`);
      break;
    default: {
      // readline 逐事件输出真实身份，不跨 Run 缓存或猜测调用顺序。
      const view = foldTerminalView(createTerminalView(), {
        type: "event",
        epoch: 0,
        event,
        observedAtMs: 0,
        ...(runId ? { runId } : {}),
      });
      for (const row of view.rows) {
        const text = formatTerminalRow(row.kind === "tool" ? { ...row, detached: false } : row);
        if (!text) continue;
        const source = event as CoreMindEvent & {
          agent?: string;
          stepId?: string;
          callId?: string;
        };
        const partial =
          row.kind === "text" || (row.kind === "artifact" && !row.call)
            ? [
                source.agent && `Agent ${source.agent}`,
                source.stepId && `Step ${source.stepId}`,
                source.callId && `Call ${source.callId}`,
              ]
                .filter((part): part is string => Boolean(part))
                .map((part) =>
                  Buffer.byteLength(part, "utf8") <= 4096 ? terminalText(part) : "身份超出显示上限",
                )
            : [];
        stream.write(`\n${text}${partial.length ? ` · ${partial.join(" · ")}` : ""}\n`);
      }
      break;
    }
  }
}
