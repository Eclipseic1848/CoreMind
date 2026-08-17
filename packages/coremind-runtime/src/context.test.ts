import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildStableContextPrefix,
  ContextProtector,
  compareContextStrategies,
  protectContext,
} from "./context.js";

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
    expect(result.reason).toBe("threshold");
    expect(result.strategy).toBe("deterministic-v1");
    expect(result.summaryFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(textOf(result.messages[0])).toContain("未完成任务：");
    expect(textOf(result.messages[0])).toContain("不确定副作用：");
  });

  it("压缩时报告被替换的输入消息范围（供会话树落盘桥接）", () => {
    const messages: AgentMessage[] = [
      user(`旧问题-${"甲".repeat(200)}`),
      assistant(`旧回答-${"乙".repeat(200)}`),
      user("最近问题"),
      assistant("最近回答"),
    ];

    const result = protectContext(messages, {
      contextWindow: 120,
      reserveTokens: 20,
      keepRecentTokens: 30,
    });

    expect(result.compacted).toBe(true);
    expect(result.replacedRange).toEqual({ start: 0, end: result.removedMessages });
    expect(result.replacedRange?.end).toBeLessThan(messages.length);
  });

  it("未压缩时替换范围为空", () => {
    const result = protectContext([user("短消息")], {
      contextWindow: 10_000,
      reserveTokens: 1_000,
      keepRecentTokens: 2_000,
    });

    expect(result.compacted).toBe(false);
    expect(result.replacedRange).toBeUndefined();
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

  it("同步 transform 拒绝异步压缩回调（避免落盘竞态，0.3.0 兼容入口）", () => {
    const failures: string[] = [];
    const messages: AgentMessage[] = [
      user(`旧问题-${"甲".repeat(200)}`),
      assistant(`旧回答-${"乙".repeat(200)}`),
      user("最近问题"),
      assistant("最近回答"),
    ];
    const protector = new ContextProtector(
      { contextWindow: 120, reserveTokens: 20, keepRecentTokens: 30 },
      async () => {},
      (failure) => failures.push(failure.message),
    );

    expect(protector.transform(messages)).toBe(messages);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("transformAsync");
  });

  it("transformAsync 回调失败时保留原消息并报告失败（落盘失败不改变发送内容）", async () => {
    const failures: string[] = [];
    const messages: AgentMessage[] = [
      user(`旧问题-${"甲".repeat(200)}`),
      assistant(`旧回答-${"乙".repeat(200)}`),
      user("最近问题"),
      assistant("最近回答"),
    ];
    const protector = new ContextProtector(
      { contextWindow: 120, reserveTokens: 20, keepRecentTokens: 30 },
      () => {
        throw new Error("落盘失败");
      },
      (failure) => failures.push(failure.message),
    );

    await expect(protector.transformAsync(messages)).resolves.toBe(messages);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("落盘失败");
  });

  it("稳定前缀不受对象键顺序和工具输入顺序影响", () => {
    const first = buildStableContextPrefix({
      projectInstructions: "只修改任务范围内的文件。",
      tools: [
        { name: "write", description: "写文件" },
        { name: "read", description: "读文件" },
      ],
      stableFacts: { model: "test-model", provider: "test-provider" },
      skillsContent: ["先验证，再交付。"],
    });
    const second = buildStableContextPrefix({
      projectInstructions: "只修改任务范围内的文件。",
      tools: [
        { name: "read", description: "读文件" },
        { name: "write", description: "写文件" },
      ],
      stableFacts: { provider: "test-provider", model: "test-model" },
      skillsContent: ["先验证，再交付。"],
    });

    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.text.indexOf("核心规则")).toBeLessThan(first.text.indexOf("项目指令"));
    expect(first.text.indexOf("项目指令")).toBeLessThan(first.text.indexOf("工具契约"));
  });

  it("只生成策略对照数据，不擅自切换默认压缩策略", () => {
    const messages: AgentMessage[] = [
      user(`任务-${"甲".repeat(300)}`),
      assistant(`处理-${"乙".repeat(300)}`),
      user("继续完成并运行测试"),
    ];
    const comparison = compareContextStrategies(messages, {
      contextWindow: 100,
      reserveTokens: 10,
      keepRecentTokens: 20,
    });

    expect(comparison.selected).toBe("deterministic-v1");
    expect(comparison.variants.map((item) => item.strategy)).toEqual([
      "none",
      "deterministic-v1",
      "deterministic-v1-more-recent",
    ]);
    expect(comparison.variants[1]?.tokens).toBeLessThan(comparison.variants[0]?.tokens ?? 0);
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
