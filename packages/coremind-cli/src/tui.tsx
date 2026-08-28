import type {
  ChatSession,
  ChildRunNodeProjection,
  ChildRunTreeProjection,
  CoreMindEvent,
  RunResult,
} from "coremind-ai";
import { Box, render, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ApprovalQueue, formatApprovalDisplay, type PendingApproval } from "./approval.js";
import { formatObservabilityStatus } from "./observability-format.js";
import { loopStateText } from "./render.js";

/** 消息视图（会话渲染用） */
interface MessageView {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools: Array<{ tool: string; args: unknown; isError?: boolean }>;
}

export interface ChatTUIProps {
  title: string;
  session: ChatSession;
  approvals: ApprovalQueue;
  /** 退出回调（外部负责 unmount 与收尾） */
  onExit: () => void;
}

/** 消息流中最多渲染的条数（全屏滚动近似） */
const MAX_VISIBLE = 30;

/**
 * 全屏交互终端（ink）：顶部标题栏 + 消息流（流式文本/工具调用可视化）+ 底部输入框。
 * 与 readline 模式共用同一 ChatSession 与事件流。
 */
export function ChatTUI({ title, session, approvals, onExit }: ChatTUIProps) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval>();
  const [lastRun, setLastRun] = useState<RunResult>();
  const [loopStatus, setLoopStatus] = useState<string>();
  const idRef = useRef(0);

  // 键盘输入（受控输入框：字符累积 / 退格 / 回车发送）
  useInput((inputStr, key) => {
    if (pendingApproval) {
      if (inputStr.toLowerCase() === "y") approvals.resolve("allow");
      if (inputStr.toLowerCase() === "n" || key.return || key.escape) approvals.resolve("deny");
      return;
    }
    if (key.return) {
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
      setMessages((prev) => {
        const next = [...prev];
        switch (event.type) {
          case "agent_start": {
            next.push({ id: idRef.current++, role: "assistant", text: "", tools: [] });
            break;
          }
          case "text_delta": {
            const last = next[next.length - 1];
            if (last && last.role === "assistant") last.text += event.delta;
            break;
          }
          case "tool_call": {
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              last.tools.push({ tool: event.tool, args: event.args });
            }
            break;
          }
          case "tool_result": {
            const last = next[next.length - 1];
            const tool = last?.tools.find((t) => t.isError === undefined) ?? last?.tools.at(-1);
            if (tool) tool.isError = event.isError;
            break;
          }
          default:
            break;
        }
        return next;
      });
    };
    return session.onEvent(pushEvent);
  }, [session]);

  const handleSubmit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed === "/abort") {
      session.abort();
      setBusy(false);
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
      setBusy(false);
    }
  };

  const appendCommandError = (error: unknown) => {
    setMessages((prev) => [
      ...prev,
      {
        id: idRef.current++,
        role: "assistant",
        text: `命令失败：${error instanceof Error ? error.message : String(error)}`,
        tools: [],
      },
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
            </Text>
          </Box>
        )}
        {visible.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        {busy && <Text dimColor>{loopStatus ? `↻ ${loopStatus}` : "…"}</Text>}
      </Box>
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
          <Text>[y] 允许 · [n/Enter] 拒绝</Text>
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
      ) : (
        <Box flexDirection="column">
          <Text color="cyan">[assistant]</Text>
          <Box paddingLeft={2} flexDirection="column">
            <Text>{msg.text}</Text>
            {toolViews.map(({ tool, key }) => (
              <Text key={key} dimColor>
                ⚙ {tool.tool}
                {tool.isError === undefined ? " …" : tool.isError ? " ✗" : " ✓"}
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
): Promise<void> {
  return new Promise((resolve) => {
    const app = render(
      <ChatTUI
        title={title}
        session={session}
        approvals={approvals}
        onExit={() => {
          app.unmount();
          resolve();
        }}
      />,
    );
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

function compactChildRunText(value: string, maxLength = 160): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function formatDelegationApproval(
  request: PendingApproval["request"],
): { target: string; task: string; budget: string; references: string } | undefined {
  if (request.tool !== "delegate" || !isRecord(request.args)) return undefined;
  const target = typeof request.args.target === "string" ? request.args.target : "未知目标";
  const task = typeof request.args.task === "string" ? request.args.task : "未提供任务";
  const limits = isRecord(request.args.limits) ? request.args.limits : {};
  const budget = [
    numericBudgetValue(limits.tokens, (value) => `${value} tokens`),
    numericBudgetValue(limits.toolCalls, (value) => `工具 ${value}`),
    numericBudgetValue(limits.costUsd, (value) => `$${value}`),
    numericBudgetValue(limits.wallTimeMs, (value) => `${value}ms`),
    numericBudgetValue(limits.steps, (value) => `步骤 ${value}`),
    numericBudgetValue(limits.descendants, (value) => `后代 ${value}`),
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const references = Array.isArray(request.args.references)
    ? request.args.references.filter((item): item is string => typeof item === "string").join("、")
    : "";
  return {
    target: compactChildRunText(target),
    task: summarizeDelegationTask(task),
    budget: budget || "使用 Config 默认预算",
    references: references || "无显式 Fact/Artifact 引用",
  };
}

function summarizeDelegationTask(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 160
    ? compact
    : `${compact.slice(0, 24)}…（任务 ${compact.length} 字符）`;
}

function numericBudgetValue(value: unknown, format: (value: number) => string): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return format(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
