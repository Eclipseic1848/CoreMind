import type { ChatSession, CoreMindEvent } from "coremind-ai";
import { Box, render, Text, useInput } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";

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
  /** 退出回调（外部负责 unmount 与收尾） */
  onExit: () => void;
}

/** 消息流中最多渲染的条数（全屏滚动近似） */
const MAX_VISIBLE = 30;

/**
 * 全屏交互终端（ink）：顶部标题栏 + 消息流（流式文本/工具调用可视化）+ 底部输入框。
 * 与 readline 模式共用同一 ChatSession 与事件流。
 */
export function ChatTUI({ title, session, onExit }: ChatTUIProps) {
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const idRef = useRef(0);

  // 键盘输入（受控输入框：字符累积 / 退格 / 回车发送）
  useInput((inputStr, key) => {
    if (key.return) {
      void handleSubmit(input);
      setInput("");
    } else if (key.backspace) {
      setInput((v) => v.slice(0, -1));
    } else if (inputStr) {
      setInput((v) => v + inputStr);
    }
  });

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
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: idRef.current++, role: "user", text: trimmed, tools: [] },
    ]);
    setBusy(true);
    try {
      await session.chat(trimmed);
    } finally {
      setBusy(false);
    }
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
            <Text color="yellow">/help 帮助 · /exit 退出 · /abort 中止当前回答（可继续提问）</Text>
          </Box>
        )}
        {visible.map((msg) => (
          <MessageRow key={msg.id} msg={msg} />
        ))}
        {busy && <Text dimColor>…</Text>}
      </Box>
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
export function runChatTUI(session: ChatSession, title: string): Promise<void> {
  return new Promise((resolve) => {
    const app = render(
      <ChatTUI
        title={title}
        session={session}
        onExit={() => {
          app.unmount();
          resolve();
        }}
      />,
    );
  });
}
