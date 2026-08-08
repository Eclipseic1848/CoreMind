import type { ChatSession, CoreMindEvent, RunResult } from "coremind-ai";
import { Box, render, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalQueue, PendingApproval } from "./approval.js";

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
    if (!trimmed || busy) return;
    if (trimmed === "/exit") {
      onExit();
      return;
    }
    if (trimmed === "/abort") {
      session.abort();
      setBusy(false);
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
          ? `changed=${diff.changed}\n--- before\n${diff.beforeText ?? "(文件不存在)"}\n+++ after\n${diff.afterText ?? "(文件不存在)"}`
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
    try {
      const result = await session.chat(trimmed);
      setLastRun(result.run);
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
              /status 状态 · /checkpoints 列表 · /diff ID · /restore ID · /exit · /abort
            </Text>
          </Box>
        )}
        {visible.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        {busy && <Text dimColor>…</Text>}
      </Box>
      {pendingApproval && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Text color="yellow" bold>
            权限审批：{pendingApproval.request.tool}（{pendingApproval.request.risk}）
          </Text>
          <Text>{JSON.stringify(pendingApproval.request.args).slice(0, 200)}</Text>
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

function formatRunStatus(run: RunResult): string {
  const metrics = run.metrics;
  const tokens = metrics.tokens === undefined ? "token 未提供" : `${metrics.tokens} tokens`;
  return `${run.outcome.status} · turn ${metrics.turns} · 工具 ${metrics.toolCalls} · ${tokens} · checkpoint ${run.checkpoints.length} · 评测场景 ${run.evaluation.scenarioResults.length}`;
}
