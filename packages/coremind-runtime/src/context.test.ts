import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { ContextProtector, protectContext } from "./context.js";

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
    expect(textOf(result.messages[0])).toContain("目标：");
    expect(textOf(result.messages[0])).toContain("约束：");
    expect(textOf(result.messages[0])).toContain("权限：");
    expect(textOf(result.messages[0])).toContain("已修改文件：");
    expect(textOf(result.messages[0])).toContain("测试状态：");
    expect(textOf(result.messages[0])).toContain("下一步：");
    expect(result.messages.map(textOf)).toContain("最近问题");
    expect(result.messages.map(textOf)).toContain("最近回答");
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("压缩异常时保留原消息并报告失败，不静默吞掉", () => {
    const failures: string[] = [];
    const invalid = [undefined as unknown as AgentMessage];
    const protector = new ContextProtector(
      { contextWindow: 1, reserveTokens: 0, keepRecentTokens: 1 },
      undefined,
      (failure) => failures.push(failure.message),
    );

    expect(protector.transform(invalid)).toBe(invalid);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("上下文压缩失败");
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
