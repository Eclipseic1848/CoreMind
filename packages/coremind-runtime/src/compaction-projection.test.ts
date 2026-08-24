import type { AgentMessage, CompactionEntry, Entry } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  applyCompaction,
  isCoremindCompaction,
  projectBranchMessages,
  projectContextCompactionLedger,
  projectRawBranchMessages,
} from "./compaction-projection.js";

describe("projectBranchMessages", () => {
  it("无压缩条目时输出全部消息与来源条目 id", () => {
    const entries = [
      messageEntry("m1", null, user("旧问题"), 1),
      messageEntry("m2", "m1", assistant("旧回答"), 2),
    ];

    const view = projectBranchMessages(entries);

    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({ entryId: "m1", seq: 1, message: { role: "user" } });
    expect(view[1]).toMatchObject({ entryId: "m2", seq: 2, message: { role: "assistant" } });
  });

  it("最后一条压缩条目之前的消息被摘要与保留尾部替换（与上游视图一致）", () => {
    const entries = [
      messageEntry("m1", null, user("很长的旧历史"), 1),
      messageEntry("m2", "m1", assistant("旧回答"), 2),
      messageEntry("m3", "m2", user("最近问题"), 3),
      compactionEntry("c1", "m3", "摘要文本", [user("保留尾部")], 900, 4),
    ];

    const view = projectBranchMessages(entries);

    // 摘要消息（上游格式）+ retainedTail，来源都是压缩条目 id
    expect(view).toHaveLength(2);
    expect(view[0]).toMatchObject({
      entryId: "c1",
      message: { role: "compactionSummary", summary: "摘要文本", tokensBefore: 900 },
    });
    expect(view[1]).toMatchObject({ entryId: "c1", message: { role: "user" } });
  });

  it("deferred 助手消息不进入视图", () => {
    const entries = [
      messageEntry("m1", null, user("问题"), 1),
      messageEntry("m2", "m1", deferredAssistant(), 2),
      messageEntry("m3", "m2", user("继续"), 3),
    ];

    const view = projectBranchMessages(entries);

    expect(view).toHaveLength(2);
    expect(view.map((item) => item.entryId)).toEqual(["m1", "m3"]);
  });

  it("模型切换等非消息条目不产生视图消息", () => {
    const entries = [
      messageEntry("m1", null, user("问题"), 1),
      {
        type: "model_change",
        id: "mc1",
        seq: 2,
        parentId: "m1",
        timestamp: 0,
        provider: "p",
        modelId: "m",
      } as Entry,
      messageEntry("m2", "mc1", assistant("回答"), 3),
    ];

    const view = projectBranchMessages(entries);

    expect(view.map((item) => item.entryId)).toEqual(["m1", "m2"]);
  });

  it("多个压缩条目只取最后一条", () => {
    const entries = [
      messageEntry("m1", null, user("最早"), 1),
      compactionEntry("c1", "m1", "第一次摘要", [], 100, 2),
      messageEntry("m2", "c1", user("中间"), 3),
      compactionEntry("c2", "m2", "第二次摘要", [user("尾部")], 200, 4),
    ];

    const view = projectBranchMessages(entries);

    expect(view.map((item) => item.message)).toEqual([
      expect.objectContaining({ role: "compactionSummary", summary: "第二次摘要" }),
      expect.objectContaining({ role: "user" }),
    ]);
    expect(view.map((item) => item.entryId)).toEqual(["c2", "c2"]);
  });
});

describe("isCoremindCompaction", () => {
  it("非压缩条目返回 false", () => {
    expect(isCoremindCompaction(messageEntry("m1", null, user("消息"), 1))).toBe(false);
  });

  it("details 缺少替换范围字段时返回 false", () => {
    expect(isCoremindCompaction(compactionEntry("c1", null, "摘要", [], 100, 1))).toBe(false);
  });

  it("details 完整时返回 true", () => {
    expect(isCoremindCompaction(coremindCompaction("c1", null, "摘要", [], 100, "a", "b", 1))).toBe(
      true,
    );
  });
});

describe("projectRawBranchMessages", () => {
  it("只输出消息条目，压缩条目留待 applyCompaction 应用", () => {
    const entries = [
      messageEntry("m1", null, user("旧"), 1),
      messageEntry("m2", "m1", assistant("旧回答"), 2),
      coremindCompaction("c1", "m2", "摘要", [user("旧"), assistant("旧回答")], 500, "m1", "m2", 3),
      messageEntry("m3", "c1", user("新"), 4),
    ];

    const raw = projectRawBranchMessages(entries);

    expect(raw.map((item) => item.entryId)).toEqual(["m1", "m2", "m3"]);
  });

  it("非消息条目与 deferred 助手消息被跳过", () => {
    const entries = [
      messageEntry("m1", null, user("旧"), 1),
      {
        type: "model_change",
        id: "mc1",
        seq: 2,
        parentId: "m1",
        timestamp: 0,
        provider: "p",
        modelId: "m",
      } as Entry,
      messageEntry("m2", "mc1", deferredAssistant(), 3),
      messageEntry("m3", "m2", user("新"), 4),
    ];

    const raw = projectRawBranchMessages(entries);

    expect(raw.map((item) => item.entryId)).toEqual(["m1", "m3"]);
  });
});

describe("projectContextCompactionLedger", () => {
  it("恢复新 lifecycle ledger，并把无该字段的历史压缩保留为 legacy unknown", () => {
    const lifecycle = {
      compactionId: "a".repeat(64),
      sourceFingerprint: "b".repeat(64),
      sourceRange: { start: 0, end: 1 },
      strategyId: "task-state" as const,
      strategyVersion: 1 as const,
      capabilityFingerprint: "c".repeat(64),
      budget: { availableInputTokens: 100, estimator: "pi-agent-core-estimate-v1" as const },
      tokensBefore: 200,
      tokensAfter: 50,
      summaryFingerprint: "d".repeat(64),
      retainedTailFingerprint: "e".repeat(64),
      taskStateFingerprint: "f".repeat(64),
      lineageDepth: 1,
      rebuiltFromCanonical: false,
      createdAt: 1,
      trigger: "threshold" as const,
    };
    const current = coremindCompaction("c2", "c1", "新摘要", [], 200, "m1", "m1", 2);
    current.details = { ...current.details, contextLifecycle: lifecycle };

    expect(
      projectContextCompactionLedger([compactionEntry("c1", null, "旧摘要", [], 100, 1), current]),
    ).toEqual([lifecycle]);
  });
});

describe("applyCompaction", () => {
  it("按替换范围重建实际发送的消息（摘要替换位置正确，丢弃其后落盘的消息）", () => {
    const entries = [
      messageEntry("m1", null, user("旧问题一"), 1),
      messageEntry("m2", "m1", assistant("旧回答一"), 2),
      messageEntry("m3", "m2", user("旧问题二"), 3),
      messageEntry("m4", "m3", assistant("旧回答二"), 4),
      messageEntry("m5", "m4", user("最近问题"), 5),
      messageEntry("m6", "m5", assistant("最近回答"), 6),
      coremindCompaction(
        "c1",
        "m6",
        "本地摘要",
        [user("最近问题"), assistant("最近回答")],
        800,
        "m1",
        "m4",
        7,
      ),
      // 压缩条目之后落盘的消息属于"本轮 Turn 消息"，不进入重建输出
      messageEntry("m7", "c1", assistant("压缩后的新回复"), 8),
    ];
    const compactions = [
      coremindCompaction(
        "c1",
        "m6",
        "本地摘要",
        [user("最近问题"), assistant("最近回答")],
        800,
        "m1",
        "m4",
        7,
      ),
    ];

    const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);

    // 发送值 = [摘要（user 格式）, ...保留尾部]
    expect(rebuilt).toHaveLength(3);
    expect(rebuilt[0]).toMatchObject({ role: "user", content: "本地摘要" });
    expect(rebuilt[1]).toMatchObject({ role: "user" });
    expect(rebuilt[2]).toMatchObject({ role: "assistant" });
  });

  it("压缩链按 seq 顺序应用，第二次压缩的范围可覆盖第一次摘要", () => {
    const entries = [
      messageEntry("m1", null, user("最旧"), 1),
      messageEntry("m2", "m1", assistant("旧回答"), 2),
      messageEntry("m3", "m2", user("中间"), 3),
      messageEntry("m4", "m3", user("最近"), 4),
      coremindCompaction(
        "c1",
        "m4",
        "第一次摘要",
        [user("中间"), user("最近")],
        700,
        "m1",
        "m2",
        5,
      ),
    ];
    const compactions = [
      coremindCompaction(
        "c1",
        "m4",
        "第一次摘要",
        [user("中间"), user("最近")],
        700,
        "m1",
        "m2",
        5,
      ),
      // 第二次压缩把第一次摘要与中间消息一起压掉，保留最近。
      // 视图里"中间"的来源是 c1（retainedTail 快照），故范围终点也是 c1。
      coremindCompaction("c2", "c1", "第二次摘要", [user("最近")], 900, "c1", "c1", 6),
    ];

    const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toMatchObject({ role: "user", content: "第二次摘要" });
    expect(rebuilt[1]).toMatchObject({ role: "user" });
  });

  it("上游 LLM 压缩（无范围）按其之前全部替换的上游语义应用", () => {
    const entries = [
      messageEntry("m1", null, user("旧消息"), 1),
      compactionEntry("c1", "m1", "上游摘要", [user("尾部")], 500, 2),
    ];
    const compactions = [compactionEntry("c1", "m1", "上游摘要", [user("尾部")], 500, 2)];

    const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toMatchObject({ role: "compactionSummary", summary: "上游摘要" });
    expect(rebuilt[1]).toMatchObject({ role: "user" });
  });

  it("替换范围起点已不在序列时跳过该条目（防御损坏数据）", () => {
    const entries = [
      messageEntry("m1", null, user("仅一条"), 1),
      messageEntry("m2", "m1", assistant("回答"), 2),
    ];
    const compactions = [
      coremindCompaction("c1", "m2", "摘要", [user("仅一条")], 100, "missing-start", "m2", 3),
    ];

    const rebuilt = applyCompaction(projectRawBranchMessages(entries), compactions);

    // 无条目被应用：原样返回全部消息
    expect(rebuilt).toHaveLength(2);
  });

  it("无压缩条目时原样返回全部消息", () => {
    const entries = [
      messageEntry("m1", null, user("一"), 1),
      messageEntry("m2", "m1", user("二"), 2),
    ];

    const rebuilt = applyCompaction(projectRawBranchMessages(entries), []);

    expect(rebuilt).toHaveLength(2);
    expect(rebuilt[0]).toMatchObject({ role: "user" });
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

/** 构造压缩条目（上游格式，无替换范围） */
function compactionEntry(
  id: string,
  parentId: string | null,
  summary: string,
  retainedTail: AgentMessage[],
  tokensBefore: number,
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
  };
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
    provider: "test",
    model: "test",
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

function deferredAssistant(): AgentMessage {
  return { ...assistant("未完成"), stopReason: "deferred" };
}
