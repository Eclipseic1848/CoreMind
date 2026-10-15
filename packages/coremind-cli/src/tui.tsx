import type {
  ChatSession,
  ChildRunNodeProjection,
  ChildRunTreeProjection,
  CoreMindConfig,
  CoreMindEvent,
  CoreMindTraceEvent,
  McpAuthentication,
  RunResult,
} from "coremind-ai";
import { Box, render, Text, useInput, usePaste, useWindowSize } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ApprovalQueue,
  compactChildRunText,
  formatApprovalDisplay,
  formatDelegationApproval,
  type PendingApproval,
} from "./approval.js";
import { formatObservabilityStatus } from "./observability-format.js";
import {
  formatArtifactReference,
  formatTerminalRow,
  loopStateText,
  terminalText,
} from "./render.js";
import {
  reduceTerminalInput,
  type TerminalInputAction,
  type TerminalInputState,
} from "./terminal-input.js";
import { createTerminalView, foldTerminalView, type TerminalRow } from "./terminal-view.js";

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

/**
 * 全屏交互终端（ink）：顶部标题栏 + 消息流（流式文本/工具调用可视化）+ 底部输入框。
 * 与 readline 模式共用同一 ChatSession 与事件流。
 */
export function ChatTUI({ title, session, approvals, onExit, mcp }: ChatTUIProps) {
  const [view, setView] = useState(createTerminalView);
  const epoch = useRef(0);
  const appendMessage = useCallback((role: "user" | "assistant" | "notice", text: string) => {
    const action = { type: "append" as const, epoch: epoch.current, role, text };
    setView((previous) => foldTerminalView(previous, action));
  }, []);
  const [editing, setEditing] = useState<TerminalInputState>({ draft: "", revision: 0 });
  const editingRef = useRef(editing);
  const input = editing.draft;
  const approvalCommand = editing.approvalCommand?.text;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [lastRun, setLastRun] = useState<RunResult>();
  const [loopStatus, setLoopStatus] = useState<string>();
  const windowSize = useWindowSize();
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

  const dispatchInput = (action: TerminalInputAction) => {
    const current = { approvalId: approvals.current?.request.approvalId };
    const next = reduceTerminalInput(editingRef.current, action, current);
    editingRef.current = next.state;
    setEditing(next.state);
    for (const effect of next.effects) {
      if (effect.type === "notice") appendMessage("notice", effect.text);
      else if (effect.type === "approval") {
        if (approvals.current?.request.approvalId === effect.approvalId)
          approvals.resolve(effect.decision);
      } else {
        const command = effect.text.trim();
        const control =
          /^\/(?:steer|follow-up)(?:\s|$)/u.test(command) ||
          command === "/abort" ||
          /^\/mcp\s+logout\s+\S+$/u.test(command);
        if (effect.target === "approval-command" && !control) {
          appendCommandError(
            new Error("审批期间使用 /steer 文本、/follow-up 文本或 /abort；Esc 返回审批"),
          );
          continue;
        }
        if (busyRef.current && !control && command !== "/children") continue;
        if (login.current && !/^\/mcp(?:\s|$)/u.test(command) && command !== "/exit") {
          appendAuthenticationNotice(
            "登录等待中；使用 /mcp cancel 取消，或 /exit 退出；原稿已保留",
          );
          continue;
        }
        const submitted = reduceTerminalInput(
          editingRef.current,
          { type: "submitted", revision: effect.revision, target: effect.target },
          current,
        );
        editingRef.current = submitted.state;
        setEditing(submitted.state);
        void handleSubmit(effect.text);
      }
    }
  };
  useInput((text, key) => dispatchInput({ type: "key", text, key }));
  usePaste((text) => dispatchInput({ type: "paste", text }));

  useEffect(() => approvals.subscribe(setPendingApproval), [approvals]);

  // 订阅会话事件：流式文本增量 + 工具调用实时状态
  useEffect(() => {
    const pushEvent = (event: CoreMindEvent, entry?: CoreMindTraceEvent) => {
      if (event.type === "loop_state") {
        setLoopStatus(loopStateText(event.to, event.iteration, event.repairs));
      }
      const action = {
        type: "event" as const,
        epoch: epoch.current,
        event,
        ...(entry ? { runId: entry.runId } : {}),
        observedAtMs: performance.now(),
      };
      setView((previous) => foldTerminalView(previous, action));
    };
    return session.onEvent(pushEvent);
  }, [session]);

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
      const controlEpoch = epoch.current;
      const message = control[2]?.trim();
      if (!message) {
        appendCommandError(new Error(`用法：/${control[1]} 文本`));
        return;
      }
      try {
        const receipt = await (control[1] === "steer"
          ? session.steer(message)
          : session.followUp(message));
        setView((previous) =>
          foldTerminalView(previous, { type: "control", epoch: controlEpoch, receipt }),
        );
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (trimmed === "/children") {
      try {
        const run = busyRef.current ? await session.inspectCurrentRunProjection() : lastRun;
        const text = run
          ? formatChildRuns(run)
          : busyRef.current
            ? "当前运行尚未产生 Child Run Projection。"
            : "尚未完成任何运行。";
        appendMessage("assistant", text);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (busyRef.current) return;
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
      appendMessage("assistant", text);
      return;
    }
    if (trimmed === "/artifacts") {
      const text = formatArtifacts(lastRun);
      appendMessage("assistant", text);
      return;
    }
    if (trimmed === "/context") {
      const text = formatContext(lastRun);
      appendMessage("assistant", text);
      return;
    }
    if (trimmed === "/observability") {
      const text = lastRun
        ? formatObservabilityStatus(lastRun.observability)
        : "尚未完成任何运行。";
      appendMessage("assistant", text);
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
      appendMessage("assistant", text);
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
        appendMessage("assistant", text);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    if (trimmed.startsWith("/restore ")) {
      const checkpointId = trimmed.slice("/restore ".length).trim();
      try {
        await session.restoreCheckpoint(checkpointId);
        appendMessage("assistant", `已恢复 checkpoint ${checkpointId}`);
      } catch (error) {
        appendCommandError(error);
      }
      return;
    }
    const runEpoch = ++epoch.current;
    setView((previous) => foldTerminalView(previous, { type: "begin", epoch: runEpoch }));
    appendMessage("user", trimmed);
    busyRef.current = true;
    setBusy(true);
    setLoopStatus(undefined);
    let runId: string | undefined;
    try {
      const result = await session.chat(trimmed);
      runId = result.run.runId;
      setLastRun(result.run);
      if (result.run.outcome.status !== "succeeded") {
        appendMessage("assistant", formatOutcomeDiagnostic(result.run));
      }
    } catch (error) {
      appendMessage(
        "assistant",
        `运行失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setView((previous) =>
        foldTerminalView(previous, { type: "end", epoch: runEpoch, ...(runId ? { runId } : {}) }),
      );
      busyRef.current = false;
      setBusy(false);
    }
  };

  const appendCommandError = (error: unknown) => {
    appendMessage("notice", `命令失败：${error instanceof Error ? error.message : String(error)}`);
  };

  const appendAuthenticationNotice = (text: string) => {
    appendMessage("notice", text);
  };

  const visible = view.rows;
  const approvalDisplay = pendingApproval
    ? formatApprovalDisplay(pendingApproval.request)
    : undefined;
  const delegationApproval = pendingApproval
    ? formatDelegationApproval(pendingApproval.request)
    : undefined;

  return (
    <Box flexDirection="column" height="100%" width={windowSize.columns}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          CoreMind · {terminalText(title)}
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
        {visible.map((row) => (
          <MessageRow key={row.id} row={row} />
        ))}
        {busy && <Text dimColor>{loopStatus ? `↻ ${loopStatus}` : "…"}</Text>}
      </Box>
      {authorization && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text>登录 {terminalText(authorization.target)}</Text>
          <Text>
            授权方：{terminalText(authorization.issuer)} · 范围：
            {terminalText(authorization.scopes)}
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
          <Text>
            审批 {terminalText(pendingApproval.request.approvalId)} ·{" "}
            {pendingApproval.request.callId
              ? `${terminalText(pendingApproval.request.agent)}/${terminalText(pendingApproval.request.stepId ?? "-")}/${terminalText(pendingApproval.request.callId)}`
              : "未绑定调用"}
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
        <Text>{terminalText(input)}</Text>
      </Box>
      {approvalCommand !== undefined && (
        <Box paddingX={1}>
          <Text>控制命令 &gt; {terminalText(approvalCommand)}</Text>
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

function MessageRow({ row }: { row: TerminalRow }) {
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text color={row.kind === "text" && row.role === "user" ? "green" : undefined}>
        {formatTerminalRow(row)}
      </Text>
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
  return `本轮 Artifact：\n${artifacts.map(formatArtifactReference).join("\n")}`;
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
