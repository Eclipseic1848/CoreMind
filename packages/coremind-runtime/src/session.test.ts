import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { CoreMindSession } from "./session.js";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-session-"));
}

const cwd = process.cwd();

describe("CoreMindSession（二期会话树存储）", () => {
  it("新建 → 落盘 → 重新打开恢复，消息一致（roundtrip）", async () => {
    const dir = makeDir();
    const opts = { dir, sessionId: "s1", cwd };
    expect(await CoreMindSession.exists(dir, "s1", cwd)).toBe(false);

    const created = await CoreMindSession.open(opts);
    expect(created.isNew).toBe(true);
    await created.appendMessages([
      { id: "m1", role: "user", content: [{ type: "text", text: "你好" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "世界" }] },
    ]);

    expect(await CoreMindSession.exists(dir, "s1", cwd)).toBe(true);

    // 重新打开（恢复语义），视图与存储一致
    const resumed = await CoreMindSession.open(opts);
    expect(resumed.isNew).toBe(false);
    const ctx = await resumed.buildContext();
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0]).toMatchObject({ role: "user" });

    // 恢复后继续追加：历史不重复
    await resumed.appendMessages([
      { id: "m3", role: "user", content: [{ type: "text", text: "继续" }] },
    ]);
    const ctx2 = await resumed.buildContext();
    expect(ctx2.messages).toHaveLength(3);
  });

  it("非法 sessionId（路径穿越防护）抛 CoreMindError", async () => {
    const dir = makeDir();
    await expect(CoreMindSession.open({ dir, sessionId: "../../evil", cwd })).rejects.toThrow(
      "会话 id",
    );
    await expect(CoreMindSession.exists(dir, "../../evil", cwd)).rejects.toThrow("会话 id");
  });

  it("不存在的会话 open 时新建，文件路径符合约定", async () => {
    const dir = makeDir();
    const cm = await CoreMindSession.open({ dir, sessionId: "s2", cwd });
    expect(cm.isNew).toBe(true);
    expect(cm.filePath).toContain("s2.jsonl");
  });

  it("maybeCompact：上下文超预算时生成摘要并替换视图（存储不变）", async () => {
    const dir = makeDir();
    const opts = { dir, sessionId: "s3", cwd };
    const cm = await CoreMindSession.open(opts);

    // 5 条长消息（估算 ≈ 1000 token，超过小窗口预算）
    const long = "字".repeat(800);
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: [{ type: "text" as const, text: `${long} 第${i}条` }],
    }));
    await cm.appendMessages(messages);
    expect((await cm.buildContext()).messages).toHaveLength(5);

    // faux 摘要模型（唯一 provider id，避免并发串扰）
    const models = createModels();
    const faux = fauxProvider({ provider: "faux-compact-1" });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("已压缩的会话摘要")]);

    const compressed = await cm.maybeCompact(models, faux.getModel(), 500, {
      enabled: true,
      reserveTokens: 100,
      keepRecentTokens: 50,
    });
    expect(compressed).toBe(true);

    // 视图被压缩替换（消息数减少）；重新打开仍可恢复（条目已持久化）
    const after = await cm.buildContext();
    expect(after.messages.length).toBeLessThan(5);
    const reopened = await CoreMindSession.open(opts);
    expect((await reopened.buildContext()).messages.length).toBeLessThan(5);
  });

  it("maybeCompact：上下文未超预算时不压缩", async () => {
    const dir = makeDir();
    const cm = await CoreMindSession.open({ dir, sessionId: "s4", cwd });
    await cm.appendMessages([
      { id: "x1", role: "user", content: [{ type: "text", text: "短消息" }] },
    ]);
    const models = createModels();
    const faux = fauxProvider({ provider: "faux-compact-2" });
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage("摘要")]);
    const compressed = await cm.maybeCompact(models, faux.getModel(), 1_000_000, {
      enabled: true,
      reserveTokens: 100,
    });
    expect(compressed).toBe(false);
  });
});
