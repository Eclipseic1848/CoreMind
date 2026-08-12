import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { CoreMindSession, migrateLegacySession } from "./session.js";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "coremind-session-"));
}

const cwd = process.cwd();

function writeLegacySession(
  dir: string,
  sessionId: string,
  entries: Record<string, unknown>[],
): string {
  const file = path.join(dir, `${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-08-10T00:00:00.000Z",
    cwd,
  };
  writeFileSync(
    file,
    `${[header, ...entries].map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
  return file;
}

function legacyMessage(id: string, parentId: string | null, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-08-10T00:00:01.000Z",
    message: { id: `message-${id}`, role: "user", content: [{ type: "text", text }] },
  };
}

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
    expect(cm.filePath).toBe(path.join(dir, "s2.jsonl"));
    expect(existsSync(cm.filePath)).toBe(true);
  });

  it("无法识别的旧公开路径拒绝静默覆盖", async () => {
    const dir = makeDir();
    writeFileSync(path.join(dir, "broken.jsonl"), "{不是有效记录", "utf8");

    expect(await CoreMindSession.exists(dir, "broken", cwd)).toBe(true);
    await expect(CoreMindSession.open({ dir, sessionId: "broken", cwd })).rejects.toThrow(
      "不是有效 JSON",
    );
  });

  it("v3 会话先备份再迁移，恢复上下文且重复打开幂等", async () => {
    const dir = makeDir();
    const file = writeLegacySession(dir, "legacy", [
      legacyMessage("old-1", null, "旧问题"),
      legacyMessage("old-2", "old-1", "旧补充"),
    ]);
    const original = readFileSync(file, "utf8");

    const migrated = await CoreMindSession.open({ dir, sessionId: "legacy", cwd });
    expect(migrated.isNew).toBe(false);
    expect(readFileSync(`${file}.v3.backup`, "utf8")).toBe(original);
    expect((await migrated.buildContext()).messages).toHaveLength(2);

    const reopened = await CoreMindSession.open({ dir, sessionId: "legacy", cwd });
    expect(reopened.isNew).toBe(false);
    expect((await reopened.buildContext()).messages).toHaveLength(2);
    expect(readFileSync(`${file}.v3.backup`, "utf8")).toBe(original);
  });

  it("迁移故障发生在公开路径切换前时保留原文件，重试可收敛", async () => {
    const dir = makeDir();
    const sessionId = "legacy-crash";
    const file = writeLegacySession(dir, sessionId, [legacyMessage("old-1", null, "保留我")]);
    const original = readFileSync(file, "utf8");
    const env = new NodeExecutionEnv({ cwd });
    const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: dir });

    await expect(
      migrateLegacySession({ dir, sessionId, cwd }, repository, file, {
        beforeAliasPublish: () => {
          throw new Error("注入故障");
        },
      }),
    ).rejects.toThrow("注入故障");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(`${file}.v3.backup`, "utf8")).toBe(original);

    const recovered = await CoreMindSession.open({ dir, sessionId, cwd });
    expect((await recovered.buildContext()).messages).toHaveLength(1);
  });

  it("无法无损表达的 v3 条目失败关闭且不改原文件", async () => {
    const dir = makeDir();
    const file = writeLegacySession(dir, "legacy-unsupported", [
      {
        type: "custom_message",
        id: "custom-1",
        parentId: null,
        timestamp: "2026-08-10T00:00:01.000Z",
        customType: "legacy",
        content: "不能静默丢弃",
      },
    ]);
    const original = readFileSync(file, "utf8");

    await expect(
      CoreMindSession.open({ dir, sessionId: "legacy-unsupported", cwd }),
    ).rejects.toThrow("无法无损迁移");
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readFileSync(`${file}.v3.backup`, "utf8")).toBe(original);
  });

  it("并发打开同一新会话只创建一个权威文件", async () => {
    const dir = makeDir();
    const opts = { dir, sessionId: "concurrent", cwd };
    const [first, second] = await Promise.all([
      CoreMindSession.open(opts),
      CoreMindSession.open(opts),
    ]);
    expect([first.isNew, second.isNew].sort()).toEqual([false, true]);
    await first.appendMessages([
      { id: "once", role: "user", content: [{ type: "text", text: "只写一次" }] },
    ]);
    expect((await second.buildContext()).messages).toHaveLength(0);
    const reopened = await CoreMindSession.open(opts);
    expect((await reopened.buildContext()).messages).toHaveLength(1);
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
