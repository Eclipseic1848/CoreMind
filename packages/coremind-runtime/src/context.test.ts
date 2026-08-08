import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { protectContext } from "./context.js";

describe("protectContext", () => {
  it("未接近上下文窗口时不改写消息", () => {
    const messages: AgentMessage[] = [user("短消息")];
    const result = protectContext(messages, {
      contextWindow: 10_000,
      reserveTokens: 1_000,
      keepRecentTokens: 2_000,
    });

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("超限时在 Loop 内生成本地摘要并保留完整的最近轮次", () => {
    const messages: AgentMessage[] = [
      user(`旧问题-${"甲".repeat(200)}`),
      assistant(`旧回答-${"乙".repeat(200)}`),
      user(`中间问题-${"丙".repeat(200)}`),
      assistant(`中间回答-${"丁".repeat(200)}`),
      user("最近问题"),
      assistant("最近回答"),
    ];

    const result = protectContext(messages, {
      contextWindow: 120,
      reserveTokens: 20,
      keepRecentTokens: 30,
    });

    expect(result.compacted).toBe(true);
    expect(result.removedMessages).toBeGreaterThan(0);
    expect(result.messages[0]?.role).toBe("user");
    expect(textOf(result.messages[0])).toContain("CoreMind 上下文摘要");
    expect(result.messages.map(textOf)).toContain("最近问题");
    expect(result.messages.map(textOf)).toContain("最近回答");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });
});

function user(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function textOf(message: AgentMessage | undefined): string {
  if (!message) return "";
  if (message.role === "user") {
    return typeof message.content === "string"
      ? message.content
      : message.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("");
  }
  if (message.role === "assistant") {
    return message.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("");
  }
  return "";
}
