import type { AgentMessage, CompactionEntry, Entry } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { rebuildRunRequest } from "./rebuild-request.js";

describe("rebuildRunRequest", () => {
  it("把稳定前缀作为 system，历史与压缩应用后的消息按序重建，末尾最终回复剔除", () => {
    // 历史：[m1 用户, m2 助手回复]；本轮：[m3 用户提问, m4 助手最终回复]
    const entries = [
      messageEntry("m1", null, user("历史问题"), 1),
      messageEntry("m2", "m1", assistant("历史回答"), 2),
      messageEntry("m3", "m2", user("本轮提问"), 3),
      messageEntry("m4", "m3", assistant("本轮回答"), 4),
    ];
    const prefix = { text: "# CoreMind 稳定上下文 v1\n...", fingerprint: "fp" };

    const rebuilt = rebuildRunRequest({ entries, compactions: [], stablePrefix: prefix });

    expect(rebuilt.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(rebuilt[0]).toMatchObject({ role: "system", content: prefix.text });
    expect(rebuilt.at(-1)).toMatchObject({ role: "user", content: "本轮提问" });
  });

  it("末尾是孤立的 toolUse（审批拒绝等未发送产出）时剔除", () => {
    const entries = [
      messageEntry("m1", null, user("问题"), 1),
      messageEntry("m2", "m1", assistantWithToolCall(), 2),
    ];

    const rebuilt = rebuildRunRequest({
      entries,
      compactions: [],
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    expect(rebuilt.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("toolUse 后有 toolResult 时保留（已作为请求上下文发送）", () => {
    const entries = [
      messageEntry("m1", null, user("问题"), 1),
      messageEntry("m2", "m1", assistantWithToolCall(), 2),
      messageEntry("m3", "m2", toolResultMessage("文件内容"), 3),
      messageEntry("m4", "m3", assistant("完成"), 4),
    ];

    const rebuilt = rebuildRunRequest({
      entries,
      compactions: [],
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    expect(rebuilt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("无任何消息时只输出 system 前缀", () => {
    const rebuilt = rebuildRunRequest({
      entries: [],
      compactions: [],
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ role: "system", content: "前缀" });
  });

  it("deferred 助手消息不进入重建（与发送一致）", () => {
    const entries = [
      messageEntry("m1", null, user("问题"), 1),
      messageEntry("m2", "m1", deferredAssistant(), 2),
      messageEntry("m3", "m2", user("继续"), 3),
    ];

    const rebuilt = rebuildRunRequest({
      entries,
      compactions: [],
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    expect(rebuilt.map((message) => message.role)).toEqual(["system", "user", "user"]);
  });

  it("CoreMind 确定性压缩条目的替换范围重建为摘要 + 保留尾部，最终回复剔除", () => {
    const entries = [
      messageEntry("m1", null, user("旧一"), 1),
      messageEntry("m2", "m1", assistant("旧答一"), 2),
      messageEntry("m3", "m2", user("旧二"), 3),
      // 本轮提问由保留尾部代表（protectContext 保留区），不单独落盘；压缩后只落 agent 回复
      coremindCompaction(
        "c1",
        "m3",
        "本地摘要",
        [user("旧二"), user("本轮提问")],
        500,
        "m1",
        "m2",
        4,
      ),
      messageEntry("m5", "c1", assistant("本轮回复"), 5),
    ];

    const rebuilt = rebuildRunRequest({
      entries,
      compactions: entries.filter((entry) => entry.type === "compaction"),
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    // 发送 = [system, 摘要(user), 保留尾部(user 旧二), 本轮提问(user)]，最终回复剔除
    expect(rebuilt.map((message) => message.role)).toEqual(["system", "user", "user", "user"]);
    expect(rebuilt[1]).toMatchObject({ role: "user", content: "本地摘要" });
    expect(rebuilt.at(-1)).toMatchObject({ role: "user", content: "本轮提问" });
  });

  it("压缩后的后续轮次消息由本轮拼接补回（规格 §2.1 三项公式）", () => {
    const entries = [
      messageEntry("m1", null, user("旧一"), 1),
      messageEntry("m2", "m1", assistant("旧答一"), 2),
      coremindCompaction("c1", "m2", "摘要", [user("旧二"), user("轮1提问")], 400, "m1", "m2", 3),
      messageEntry("m3", "c1", assistant("轮1回复"), 4),
      messageEntry("m4", "m3", user("轮2提问"), 5),
      messageEntry("m5", "m4", assistant("轮2回复"), 6),
    ];

    const rebuilt = rebuildRunRequest({
      entries,
      compactions: entries.filter((entry) => entry.type === "compaction"),
      stablePrefix: { text: "前缀", fingerprint: "fp" },
    });

    // 重建 = [system, 摘要, 保留尾部(user 旧二), 轮1提问(user), 轮1回复, 轮2提问]，轮2回复剔除
    expect(rebuilt.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "user",
      "assistant",
      "user",
    ]);
    expect(rebuilt.at(-1)).toMatchObject({ role: "user", content: "轮2提问" });
  });
});

/** 构造消息条目 */
function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentMessage,
  seq: number,
): Entry {
  return { type: "message", id, seq, parentId, timestamp: 0, message };
}

/** 构造 CoreMind 确定性压缩条目（details 携带替换范围与指纹） */
function coremindCompaction(
  id: string,
  parentId: string | null,
  summary: string,
  retainedTail: AgentMessage[],
  tokensBefore: number,
  rangeStartId: string,
  rangeEndId: string,
  seq: number,
): CompactionEntry {
  return {
    type: "compaction",
    id,
    seq,
    parentId,
    timestamp: 0,
    summary,
    retainedTail,
    tokensBefore,
    details: {
      fingerprint: `${id}-fingerprint`,
      rangeStartId,
      rangeEndId,
    },
  };
}

function user(content: string): AgentMessage {
  return { role: "user", content, timestamp: 0 };
}

function assistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "probe",
    model: "probe-model",
    stopReason: "stop",
    timestamp: 0,
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

function assistantWithToolCall(): AgentMessage {
  return {
    ...assistant(""),
    content: [
      {
        type: "toolCall",
        id: "call-read",
        name: "read",
        args: { path: "notes.txt" },
      },
    ],
    stopReason: "toolUse",
  };
}

function toolResultMessage(text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-read",
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 0,
  };
}

function deferredAssistant(): AgentMessage {
  return { ...assistant("未完成"), stopReason: "deferred" };
}
