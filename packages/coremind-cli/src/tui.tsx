import type {
  ChatSession,
  ChildRunNodeProjection,
  ChildRunTreeProjection,
  CoreMindConfig,
  CoreMindEvent,
  McpAuthentication,
  RunResult,
} from "coremind-ai";
import { Box, render, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ApprovalQueue,
  compactChildRunText,
  formatApprovalDisplay,
  formatDelegationApproval,
  type PendingApproval,
} from "./approval.js";
import { formatObservabilityStatus } from "./observability-format.js";
import { loopStateText } from "./render.js";

/** 消息视图（会话渲染用） */
interface MessageView {
  id: number;
  role: "user" | "assistant" | "notice";
  text: string;
  tools: Array<{
    tool: string;
    args: unknown;
    callId?: string;
    isError?: boolean;
    ended?: boolean;
  }>;
}

export interface ChatTUIProps {
  title: string;
  session: ChatSession;
  approvals: ApprovalQueue;
  /** 退出回调（外部负责 unmount 与收尾） */
  onExit: () => void;
  mcp?: McpChatAuthentication;
}

/** 认证会话由命令入口持有，视图只发起或取消事务。 */
export interface McpChatAuthentication {
  authentication: McpAuthentication;
  config: CoreMindConfig;
}

/** 认证错误不回显外部响应或原始异常，避免授权信息落入消息流。 */
export function formatMcpAuthenticationError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "aborted") return "登录已取消";
  if (code === "run_timeout") return "登录已超时，请重新发起";
  if (code === "mcp_auth_required") return "服务需要显式登录";
  if (code === "mcp_auth_store_failed") return "凭据存储失败";
  return "认证失败，请检查服务配置后重试";
}

/** 消息流中最多渲染的条数（全屏滚动近似） */
const MAX_VISIBLE = 30;

/**
 * 全屏交互终端（ink）：顶部标题栏 + 消息流（流式文本/工具调用可视化）+ 底部输入框。
 * 与 readline 模式共用同一 ChatSession 与事件流。
 */
export function ChatTUI({ title, session, approvals, onExit, mcp }: ChatTUIProps) {
  const [messages, updateMessages] = useState<MessageView[]>([]);
  const setMessages = useCallback((update: (previous: MessageView[]) => MessageView[]) => {
    updateMessages((previous) => {
      const next = update(previous);
      if (next === previous || next.length <= MAX_VISIBLE) return next;
      // 仅额外保留尚未收到结果的工具消息，避免迟到结果失去显示绑定。
      return next.filter(
        (message, index) =>
          index >= next.length - MAX_VISIBLE ||
          message.tools.some((tool) => tool.isError === undefined && !tool.ended),
      );
    });
  }, []);
  const [input, setInput] = useState("");
  const [approvalCommand, setApprovalCommand] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [lastRun, setLastRun] = useState<RunResult>();
  const [loopStatus, setLoopStatus] = useState<string>();
  const idRef = useRef(0);
  const login = useRef<{ controller: AbortController; operation: Promise<void> } | undefined>(
    undefined,
  );
  const mounted = useRef(true);
  const [authorization, setAuthorization] = useState<{
    target: string;
    issuer: string;
    scopes: string;
    url?: string;
  }>();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      login.current?.controller.abort();
    };
  }, []);

  // 键盘输入（受控输入框：字符累积 / 退格 / 回车发送）
  useInput((inputStr, key) => {
    if (approvalCommand !== undefined) {
      if (key.escape) setApprovalCommand(undefined);
      else if (key.return) {
        const command = approvalCommand.trim();
        if (
          /^\/(?:steer|follow-up)(?:\s|$)/u.test(command) ||
          command === "/abort" ||
          /^\/mcp\s+logout\s+\S+$/u.test(command)
        ) {
          void handleSubmit(command);
          setApprovalCommand(undefined);
        } else
          appendCommandError(
            new Error("审批期间使用 /steer 文本、/follow-up 文本或 /abort；Esc 返回审批"),
          );
      } else if (key.backspace) setApprovalCommand((value) => value?.slice(0, -1));
      else if (inputStr) setApprovalCommand((value) => (value ?? "") + inputStr);
      return;
    }
    if (pendingApproval) {
      if (inputStr.startsWith("/")) {
        setApprovalCommand(inputStr);
        return;
      }
      if (inputStr.toLowerCase() === "y") approvals.resolve("allow");
      if (inputStr.toLowerCase() === "n" || key.return || key.escape) approvals.resolve("deny");
      return;
    }
    if (key.return) {
      const command = input.trim();
      if (
        busy &&
        command !== "/abort" &&
        command !== "/children" &&
        !/^\/mcp\s+logout\s+\S+$/u.test(command) &&
        !/^\/(?:steer|follow-up)(?:\s|$)/u.test(command)
      )
        return;
      void handleSubmit(input);
      setInput("");
    } else if (key.backspace) {
      setInput((v) => v.slice(0, -1));
    } else if (inputStr) {
      setInput((v) => v + inputStr);
    }
  });

  useEffect(() => approvals.subscribe(setPendingApproval), [approvals]);

  // 订阅会话事件：流式文本增量 + 工具调用实时状态
  useEffect(() => {
    const pushEvent = (event: CoreMindEvent) => {
      if (event.type === "loop_state") {
        setLoopStatus(loopStateText(event.to, event.iteration, event.repairs));
      }
      if (
        ![
          "agent_start",
          "text_delta",
          "tool_call",
          "tool_result",
          "input_receipt",
          "input_claimed",
          "input_completed",
          "input_discarded",
        ].includes(event.type)
      )
        return;
      setMessages((prev) => {
        const next = [...prev];
        switch (event.type) {
          case "agent_start": {
            next.push({ id: idRef.current++, role: "assistant", text: "", tools: [] });
            break;
          }
          case "text_delta": {
            const index = next.map((message) => message.role).lastIndexOf("assistant");
            const last = next[index];
            if (last && last.role === "assistant") {
              next[index] = { ...last, text: last.text + event.delta };
            }
            break;
          }
          case "tool_call": {
            const index = next.map((message) => message.role).lastIndexOf("assistant");
            const last = next[index];
            if (last && last.role === "assistant") {
              next[index] = {
                ...last,
                tools: [
                  ...last.tools,
                  { tool: event.tool, args: event.args, callId: event.callId },
                ],
              };
            }
            break;
          }
          case "tool_result": {
            // 带身份的结果可晚于其他消息到达；旧事件仅匹配同名未完成调用。
            for (let index = next.length - 1; index >= 0; index--) {
              const message = next[index]!;
              const toolIndex = message.tools.findIndex((tool) =>
                event.callId !== undefined
                  ? tool.callId === event.callId
                  : tool.tool === event.tool && tool.isError === undefined,
              );
              if (toolIndex < 0) continue;
              next[index] = {
                ...message,
                tools: message.tools.map((tool, i) =>
                  i === toolIndex ? { ...tool, isError: event.isError } : tool,
                ),
              };
              break;
            }
            break;
          }
          case "input_receipt":
          case "input_claimed":
          case "input_completed":
          case "input_discarded": {
            next.push({
              id: idRef.current++,
              role: "notice",
              text: `输入 ${event.inputId} · ${event.status}${event.type === "input_claimed" ? ` · Turn ${event.turnId}` : ""}`,
              tools: [],
            });
            break;
          }
          default:
            break;
        }
        return next;
      });
    };
    return session.onEvent(pushEvent);
  }, [session, setMessages]);

  const handleSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^\/mcp(?:\s|$)/u.test(trimmed)) {
      if (trimmed === "/mcp cancel") {
        login.current?.controller.abort();
        setAuthorization(undefined);
        return;
      }
      const command = /^\/mcp\s+(login|logout)\s+(\S+)$/u.exec(trimmed);
      if (!command) {
        appendCommandError(new Error("用法：/mcp login 服务、/mcp cancel、/mcp logout 服务"));
        return;
      }
      const serverName = command[2]!;
      const server = mcp?.config.mcp?.servers[serverName];
      if (!mcp || server?.transport !== "streamable-http" || !server.oauth) {
        appendCommandError(new Error("指定服务没有配置 OAuth 登录"));
        return;
      }
      if (command[1] === "logout") {
        login.current?.controller.abort();
        setAuthorization(undefined);
        try {
          await mcp.authentication.logout(serverName);
          appendAuthenticationNotice("已清除当前进程的服务凭据");
        } catch (error) {
          appendCommandError(new Error(formatMcpAuthenticationError(error)));
        }
        return;
      }
      if (busy || pendingApproval || login.current) {
        appendCommandError(new Error("请等待当前运行、审批或登录结束后再登录"));
        return;
      }
      const controller = new AbortController();
      setAuthorization({
        target: `${serverName}：${server.url}`,
        issuer: server.oauth.issuer,
        scopes: server.oauth.scopes.join("、"),
      });
      const operation = mcp.authentication
        .login(serverName, {
          signal: controller.signal,
          onAuthorization: (request, signal) => {
            signal.throwIfAborted();
            if (mounted.current)
              setAuthorization((previous) =>
                previous ? { ...previous, url: request.authorizationUrl } : previous,
              );
          },
        })
        .then(
          () => {
            if (mounted.current) appendAuthenticationNotice("登录成功，可继续提问");
          },
          (error: unknown) => {
            if (mounted.current) appendAuthenticationNotice(formatMcpAuthenticationError(error));
          },
        )
        .finally(() => {
          if (login.current?.controller === controller) {
            login.current = undefined;
            if (mounted.current) setAuthorization(undefined);
          }
        });
      login.current = { controller, operation };
      return;
    }
    if (trimmed === "/exit" && login.current) {
      login.current.controller.abort();
      setAuthorization(undefined);
      await login.current.operation;
      onExit();
      return;
    }
    if (login.current) {
      appendAuthenticationNotice("登录等待中；使用 /mcp cancel 取消，或 /exit 退出");
      return;
    }
    if (trimmed === "/abort") {
      session.abort();
      while (approvals.current) approvals.resolve("deny");
      return;
    }
    const control = /^\/(steer|follow-up)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    if (control) {
      const message = control[2]?.trim();
      if (!message) {
        appendCommandError(new Error(`用法：/${control[1]} 文本`));
        return;
      }
      try {
        const receipt = await (control[1] === "steer"
          ? session.steer(message)
          : session.followUp(message));
        setMessages((previous) => [
          ...previous,
          {
            id: idRef.current++,
            role: "notice",
            text: `控制 ${receipt.controlId} · Run ${receipt.runId} · ${receipt.status}${receipt.duplicateOf ? ` (${receipt.duplicateOf})` : ""}${receipt.reason ? `：${receipt.reason}` : ""}`,
            tools: [],
          },
        ]);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (trimmed === "/children") {
      try {
        const run = busy ? await session.inspectCurrentRunProjection() : lastRun;
        const text = run
          ? formatChildRuns(run)
          : busy
            ? "当前运行尚未产生 Child Run Projection。"
            : "尚未完成任何运行。";
        setMessages((prev) => [
          ...prev,
          { id: idRef.current++, role: "assistant", text, tools: [] },
        ]);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (busy) return;
    if (trimmed === "/exit") {
      onExit();
      return;
    }
    if (trimmed === "/help") {
      setShowHelp((v) => !v);
      return;
    }
    if (trimmed === "/status") {
      const text = lastRun ? formatRunStatus(lastRun) : "尚未完成任何运行。";
      setMessages((prev) => [...prev, { id: idRef.current++, role: "assistant", text, tools: [] }]);
      return;
    }
    if (trimmed === "/artifacts") {
      const text = formatArtifacts(lastRun);
      setMessages((prev) => [...prev, { id: idRef.current++, role: "assistant", text, tools: [] }]);
      return;
    }
    if (trimmed === "/context") {
      const text = formatContext(lastRun);
      setMessages((prev) => [...prev, { id: idRef.current++, role: "assistant", text, tools: [] }]);
      return;
    }
    if (trimmed === "/observability") {
      const text = lastRun
        ? formatObservabilityStatus(lastRun.observability)
        : "尚未完成任何运行。";
      setMessages((prev) => [...prev, { id: idRef.current++, role: "assistant", text, tools: [] }]);
      return;
    }
    if (trimmed === "/checkpoints") {
      const checkpoints = session.listCheckpoints();
      const text =
        checkpoints.length === 0
          ? "当前没有 checkpoint。"
          : checkpoints
              .map(
                (item) =>
                  `${item.checkpointId} · ${item.tool} · ${item.reversible ? "可恢复" : "不可自动恢复"}`,
              )
              .join("\n");
      setMessages((prev) => [...prev, { id: idRef.current++, role: "assistant", text, tools: [] }]);
      return;
    }
    if (trimmed.startsWith("/diff ")) {
      const checkpointId = trimmed.slice("/diff ".length).trim();
      try {
        const diff = await session.diffCheckpoint(checkpointId);
        const text = diff.reversible
          ? `changed=${diff.changed}\n${
              diff.unifiedDiff ??
              `--- before\n${diff.beforeText ?? "(文件不存在)"}\n+++ after\n${diff.afterText ?? "(文件不存在)"}`
            }`
          : `不可自动比较：${diff.reason ?? "未知原因"}`;
        setMessages((prev) => [
          ...prev,
          { id: idRef.current++, role: "assistant", text, tools: [] },
        ]);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (trimmed.startsWith("/restore ")) {
      const checkpointId = trimmed.slice("/restore ".length).trim();
      try {
        await session.restoreCheckpoint(checkpointId);
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: "assistant",
            text: `已恢复 checkpoint ${checkpointId}`,
            tools: [],
          },
        ]);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: idRef.current++, role: "user", text: trimmed, tools: [] },
    ]);
    setBusy(true);
    setLoopStatus(undefined);
    try {
      const result = await session.chat(trimmed);
      setLastRun(result.run);
      if (result.run.outcome.status !== "succeeded") {
        setMessages((prev) => [
          ...prev,
          {
            id: idRef.current++,
            role: "assistant",
            text: formatOutcomeDiagnostic(result.run),
            tools: [],
          },
        ]);
      }
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          id: idRef.current++,
          role: "assistant",
          text: `运行失败：${error instanceof Error ? error.message : String(error)}`,
          tools: [],
        },
      ]);
    } finally {
      setMessages((previous) =>
        previous.map((message) => ({
          ...message,
          tools: message.tools.map((tool) =>
            tool.isError === undefined ? { ...tool, ended: true } : tool,
          ),
        })),
      );
      setBusy(false);
    }
  };

  const appendCommandError = (error: unknown) => {
    setMessages((prev) => [
      ...prev,
      {
        id: idRef.current++,
        role: "notice",
        text: `命令失败：${error instanceof Error ? error.message : String(error)}`,
        tools: [],
      },
    ]);
  };

  const appendAuthenticationNotice = (text: string) => {
    setMessages((previous) => [
      ...previous,
      { id: idRef.current++, role: "notice", text, tools: [] },
    ]);
  };

  const visible = messages.slice(-MAX_VISIBLE);
  const approvalDisplay = pendingApproval
    ? formatApprovalDisplay(pendingApproval.request)
    : undefined;
  const delegationApproval = pendingApproval
    ? formatDelegationApproval(pendingApproval.request)
    : undefined;

  return (
    <Box flexDirection="column" height="100%">
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          CoreMind · {title}
        </Text>
        <Text dimColor> /help 查看命令 · /exit 退出</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {showHelp && (
          <Box marginY={1}>
            <Text color="yellow">
              /status 状态 · /children 子运行 · /artifacts 产物 · /context 上下文 · /observability
              观测 · /checkpoints 列表 · /diff ID · /restore ID · /exit · /abort
              {"\n"}/steer 文本：追加指令 · /follow-up 文本：任务自然结束后继续
              {"\n"}/mcp login 服务 · /mcp cancel · /mcp logout 服务（凭据仅当前进程保存）
              {"\n"}applied 仅表示已交队列；输入的 claimed/completed/discarded 单独显示。
            </Text>
          </Box>
        )}
        {visible.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        {busy && <Text dimColor>{loopStatus ? `↻ ${loopStatus}` : "…"}</Text>}
      </Box>
      {authorization && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text>登录 {authorization.target}</Text>
          <Text>
            授权方：{authorization.issuer} · 范围：{authorization.scopes}
          </Text>
          <Text>{authorization.url ?? "正在准备授权链接…"}</Text>
          <Text>请手动打开链接；/mcp cancel 取消 · /exit 退出；凭据仅当前进程保存</Text>
        </Box>
      )}
      {pendingApproval && approvalDisplay && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            {delegationApproval
              ? `Child Run 委派审批：${delegationApproval.target}`
              : `权限审批：${pendingApproval.request.tool}（${pendingApproval.request.risk}）`}
          </Text>
          {delegationApproval ? (
            <>
              <Text>任务：{delegationApproval.task}</Text>
              <Text>预算：{delegationApproval.budget}</Text>
              <Text>层级：{delegationApproval.hierarchy}</Text>
              <Text>引用：{delegationApproval.references}</Text>
              <Text>授权：仅创建 Child Run；子级工具与外部副作用仍需独立审批</Text>
            </>
          ) : (
            <>
              <Text>副作用：{approvalDisplay.effect}</Text>
              <Text>目标：{approvalDisplay.targets}</Text>
              <Text>参数：{approvalDisplay.arguments}</Text>
            </>
          )}
          <Text>原因：{approvalDisplay.reason}</Text>
          <Text>[y] 允许 · [n/Enter] 拒绝 · [/] 输入控制命令，Esc 返回审批</Text>
        </Box>
      )}
      {lastRun && (
        <Box paddingX={1}>
          <Text dimColor>{formatRunStatus(lastRun)}</Text>
        </Box>
      )}
      <Box borderStyle="round" paddingX={1}>
        <Text color="green">你 &gt; </Text>
        <Text>{input}</Text>
      </Box>
      {approvalCommand !== undefined && (
        <Box paddingX={1}>
          <Text>控制命令 &gt; {approvalCommand}</Text>
        </Box>
      )}
      {busy && (
        <Text dimColor>
          普通输入保留为草稿；/steer 追加指令 · /follow-up 后续输入 · /abort 中止
        </Text>
      )}
      {!busy && <Text dimColor>输入就绪{input ? "，按 Enter 发送草稿" : ""}</Text>}
    </Box>
  );
}

function MessageRow({ msg }: { msg: MessageView }) {
  // 工具行 key：同名工具按出现次数计数（避免数组索引作 key）
  const toolViews = useMemo(() => {
    const seen: Record<string, number> = {};
    return msg.tools.map((tool) => {
      seen[tool.tool] = (seen[tool.tool] ?? 0) + 1;
      return { tool, key: `${tool.tool}-${seen[tool.tool]}` };
    });
  }, [msg.tools]);
  return (
    <Box flexDirection="column" marginBottom={0}>
      {msg.role === "user" ? (
        <Text color="green">你 &gt; {msg.text}</Text>
      ) : msg.role === "notice" ? (
        <Text dimColor>{msg.text}</Text>
      ) : (
        <Box flexDirection="column">
          <Text color="cyan">[assistant]</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text>{msg.text}</Text>
            {toolViews.map(({ tool, key }) => (
              <Text key={key} dimColor>
                ⚙ {tool.tool}
                {tool.isError === undefined
                  ? tool.ended
                    ? " ?"
                    : " …"
                  : tool.isError
                    ? " ✗"
                    : " ✓"}
              </Text>
            ))}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** 运行全屏 TUI（渲染并等待退出） */
export function runChatTUI(
  session: ChatSession,
  title: string,
  approvals: ApprovalQueue,
  mcp?: McpChatAuthentication,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const app = render(
      <ChatTUI
        title={title}
        session={session}
        approvals={approvals}
        mcp={mcp}
        onExit={() => {
          app.unmount();
          resolve();
        }}
      />,
    );
    const onEnd = () => app.unmount();
    process.stdin.once("end", onEnd);
    void app
      .waitUntilExit()
      .then(() => resolve(), reject)
      .finally(() => {
        process.stdin.off("end", onEnd);
      });
  });
}

export function formatRunStatus(run: RunResult): string {
  const metrics = run.metrics;
  const tokens = metrics.tokens === undefined ? "token 未提供" : `${metrics.tokens} tokens`;
  const artifacts = metrics.artifacts ?? { stored: 0, blocked: 0, totalBytes: 0 };
  const context = metrics.context;
  const recovery = run.snapshot.resumable ? "可恢复" : "不可恢复";
  const evaluation = run.releaseReadiness.ready
    ? `评测 ${run.evaluation.scenarioResults.length} · 可发布`
    : `评测 ${run.evaluation.scenarioResults.length} · 阻断 ${run.releaseReadiness.blockers.length}`;
  const children = run.childRuns
    ? ` · Child Runs ${run.childRuns.nodes.length} · 活动 ${run.childRuns.activeDescendants} · 未处置 ${run.childRuns.unhandledDescendants}`
    : "";
  return `${run.outcome.status} · operation ${run.operation.state} · ${recovery} · turn ${metrics.turns} · 工具 ${metrics.toolCalls} · ${tokens} · checkpoint ${run.checkpoints.length} · artifact ${artifacts.stored}/${artifacts.blocked} · 压缩 ${context?.compactions ?? 0}${children} · Telemetry ${run.observability.telemetry.mode} · ${evaluation}`;
}

export function formatChildRuns(run: { childRuns?: ChildRunTreeProjection } | undefined): string {
  if (!run) return "尚未完成任何运行。";
  if (!run.childRuns || run.childRuns.nodes.length === 0) return "本轮没有 Child Run。";
  const { nodes, activeDescendants, unhandledDescendants, quiescent } = run.childRuns;
  const childIds = new Set(nodes.map((node) => node.childRunId));
  const childrenByParent = new Map<string, ChildRunNodeProjection[]>();
  for (const node of nodes) {
    const children = childrenByParent.get(node.parentRunId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentRunId, children);
  }
  const roots = nodes.filter((node) => !childIds.has(node.parentRunId));
  const lines = [
    `Child Runs ${nodes.length} · 活动 ${activeDescendants} · 未处置 ${unhandledDescendants} · ${quiescent ? "已静止" : "未静止"}`,
  ];
  const rendered = new Set<string>();
  const appendNode = (node: ChildRunNodeProjection, depth: number, last: boolean) => {
    if (rendered.has(node.childRunId)) return;
    rendered.add(node.childRunId);
    const prefix = "   ".repeat(depth);
    const detailsPrefix = `${prefix}   `;
    const outcome = node.outcome
      ? `${node.outcome.status}/${compactChildRunText(node.outcome.finishReason)}`
      : "等待结果";
    const recovery = node.recovery;
    lines.push(
      `${prefix}${last ? "└─" : "├─"} 目标 ${compactChildRunText(node.agentName)} · ${node.status} · ${outcome}`,
    );
    lines.push(
      `${detailsPrefix}身份 ${node.parentRunId} → ${node.childRunId} · ${node.delegationId}`,
    );
    lines.push(
      `${detailsPrefix}预算 ${node.budget.tokens} tokens · 工具 ${node.budget.toolCalls} · $${node.budget.costUsd} · ${node.budget.wallTimeMs}ms · 步骤 ${node.budget.steps} · 后代 ${node.budget.descendants}`,
    );
    const recoverySummary = recovery
      ? `${recovery.resumable ? "可恢复" : "不可恢复"} · ${recovery.requiresHuman ? "需要人工" : "无需人工"}`
      : "等待投影";
    lines.push(
      `${detailsPrefix}Recovery ${recoverySummary} · 未决风险 ${node.result?.unresolvedRisks.length ?? 0}`,
    );
    for (const risk of node.result?.unresolvedRisks ?? []) {
      lines.push(`${detailsPrefix}风险：${compactChildRunText(risk)}`);
    }
    const children = childrenByParent.get(node.childRunId) ?? [];
    children.forEach((child, index) => {
      appendNode(child, depth + 1, index === children.length - 1);
    });
  };
  roots.forEach((node, index) => {
    appendNode(node, 0, index === roots.length - 1);
  });
  nodes
    .filter((node) => !rendered.has(node.childRunId))
    .forEach((node, index, remaining) => {
      appendNode(node, 0, index === remaining.length - 1);
    });
  return lines.join("\n");
}

function formatArtifacts(run: RunResult | undefined): string {
  if (!run) return "尚未完成任何运行。";
  const artifacts = run.snapshot.artifacts;
  if (artifacts.length === 0) return "本轮没有 Artifact。";
  return artifacts
    .map((artifact) => {
      const location = artifact.relativePath ?? "未保存";
      return `${artifact.artifactId} · ${artifact.status} · ${artifact.sizeBytes} bytes · ${location}`;
    })
    .join("\n");
}

function formatContext(run: RunResult | undefined): string {
  if (!run) return "尚未完成任何运行。";
  const context = run.snapshot.metrics.context;
  if (!context) return "Provider 未提供上下文用量。";
  return `上下文输入 ${context.inputTokens} · 输出 ${context.outputTokens} · cache ${context.promptCacheStatus}（读 ${context.cacheReadTokens} / 写 ${context.cacheWriteTokens}）· 压缩 ${context.compactions} · 稳定前缀 ${context.stablePrefixFingerprints.length}`;
}

function formatOutcomeDiagnostic(run: RunResult): string {
  const labels: Record<Exclude<RunResult["outcome"]["status"], "succeeded">, string> = {
    failed: "运行失败",
    paused: "运行暂停",
    aborted: "运行中止",
    timeout: "运行超时",
    budget_exceeded: "预算超限",
  };
  const status = run.outcome.status;
  if (status === "succeeded") return "运行成功";
  return `${labels[status]}：${run.outcome.error?.message ?? run.outcome.finishReason}`;
}
