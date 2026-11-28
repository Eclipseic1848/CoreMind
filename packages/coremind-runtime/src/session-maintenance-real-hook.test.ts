import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { RunBudgetController, resolveRuntimeLimits } from "./budget.js";
import { FileRunStore, RunStateJournal } from "./run-state.js";
import { CoreMindSession, openWritableSession, sessionHasPendingWrites } from "./session.js";
import { compactSessionInRun } from "./session-maintenance.js";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
} from "./session-v4/index.js";
import {
  acquireSessionWriteLease,
  assertSessionWriteLease,
  type SessionWriteLease,
} from "./session-write-lease.js";

const summaryCases = [
  ["普通摘要", "stop", "真实维护摘要", true],
  ["普通摘要", "length", "未写完的摘要", false],
  ["普通摘要", "stop", " \n\t", false],
  ["轮内前缀摘要", "stop", "真实维护摘要", true],
  ["轮内前缀摘要", "length", "未写完的摘要", false],
  ["轮内前缀摘要", "stop", " \n\t", false],
] as const;

it.each(summaryCases)("%s（%s，%j）的维护计量与会话恢复", async (kind, reason, text, accepted) => {
  const split = kind === "轮内前缀摘要";
  const root = path.resolve(tmpdir());
  const dir = mkdtempSync(path.join(root, "coremind-session-maintenance-hook-"));
  const opts = { dir, cwd: dir, sessionId: "maintenance-hook" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const journal = new RunStateJournal(
    "maintenance-hook",
    new FileRunStore(path.join(dir, "journal")),
  );
  let lease: SessionWriteLease | undefined;
  let session: CoreMindSession | undefined;
  let operation: Promise<void> | undefined;
  try {
    lease = await acquireSessionWriteLease(dir, opts.sessionId);
    session = await openWritableSession(opts, lease);
    // 每条约 3k token；第 14 条让保留边界落在助手消息，触发额外的轮内前缀摘要。
    await session.appendMessages(
      Array.from({ length: split ? 14 : 13 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text" as const, text: `${index}: ${"old ".repeat(3000)}` }],
        timestamp: index + 1,
      })),
    );
    const prefix = readFileSync(session.filePath);
    const before = await session.branchEntries();
    const original = (await session.buildContext()).messages;
    expect(estimateContextTokens(original).tokens).toBeGreaterThan(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );
    const prep = prepareCompaction(before, DEFAULT_COMPACTION_SETTINGS);
    expect(
      prep.ok &&
        prep.value &&
        prep.value.isSplitTurn === split &&
        prep.value.messagesToSummarize.length > 0,
    ).toBe(true);
    const models = createModels();
    const faux = fauxProvider({
      provider: `maintenance-${randomUUID()}`,
      tokensPerSecond: 0,
      models: [{ id: "summary", contextWindow: 30_000, maxTokens: 1024 }],
    });
    models.setProvider(faux.provider);
    faux.setResponses([
      ...(split ? [fauxAssistantMessage("此前轮次的摘要")] : []),
      async () => {
        await assertSessionWriteLease(lease!, lease!.sessionPath);
        expect(sessionHasPendingWrites(session!)).toBe(true);
        return fauxAssistantMessage(text, { stopReason: reason });
      },
    ]);
    await journal.start({ configName: "maintenance-hook" });
    const chargedTokens: number[] = [];
    operation = compactSessionInRun({
      runId: "maintenance-hook",
      agent: "main",
      session,
      models,
      model: faux.getModel(),
      journal,
      signal: controller.signal,
      emit: (event) => {
        if (event.type === "turn_end") chargedTokens.push(event.tokens ?? 0);
      },
      budget: new RunBudgetController(
        resolveRuntimeLimits(
          {},
          {
            maxTurns: 2,
            maxTokens: 100_000,
            maxRetries: 0,
          },
        ),
        () => {},
      ),
    });
    await operation;
    expect(sessionHasPendingWrites(session)).toBe(false);
    expect(faux.state.callCount).toBe(split ? 2 : 1);
    const entries = await session.branchEntries();
    const records = entries.flatMap((entry) =>
      entry.type === "custom" && entry.customType === "coremind.session-maintenance.v1"
        ? [entry.data as { status: string; usage?: { totalTokens: number } }]
        : [],
    );
    expect(records.map((record) => record.status)).toEqual([
      ...(split ? ["requested", "stop"] : []),
      "requested",
      reason,
      accepted ? "compacted" : "unchanged",
    ]);
    expect(chargedTokens).toHaveLength(faux.state.callCount);
    expect(chargedTokens.every((value) => value > 0)).toBe(true);
    expect(records.flatMap((record) => record.usage?.totalTokens ?? [])).toEqual(chargedTokens);
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(accepted ? 1 : 0);
    const reopened = await CoreMindSession.open(opts);
    const recovered = (await reopened.buildContext()).messages;
    if (accepted) {
      const compaction = compactions[0]!;
      expect(compaction.summary).toContain(text);
      if (split) expect(compaction.summary).toContain("此前轮次的摘要");
      expect(compaction.usage?.totalTokens).toBe(
        chargedTokens.reduce((sum, value) => sum + value, 0),
      );
      expect(compaction.retainedTail.length).toBeGreaterThan(0);
      expect(recovered[0]).toMatchObject({
        role: "compactionSummary",
        summary: compaction.summary,
      });
    } else {
      expect(recovered).toEqual(original);
    }
    expect(entries.slice(0, before.length)).toEqual(before);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    entries.forEach((entry, index) => {
      expect(entry.parentId).toBe(entries[index - 1]?.id ?? null);
    });
    expect(readFileSync(session.filePath).subarray(0, prefix.length)).toEqual(prefix);
    await assertSessionWriteLease(lease, lease.sessionPath);
    expect(await reopened.branchEntries()).toEqual(entries);
    if (!accepted) {
      faux.setResponses([
        ...(split ? [fauxAssistantMessage("此前轮次的摘要")] : []),
        fauxAssistantMessage("重试后完成的摘要"),
      ]);
      expect(
        await session.maybeCompact(models, faux.getModel(), faux.getModel().contextWindow),
      ).toBe(true);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
    // 先收敛真实维护 Promise，其内部 finally 完成后再检查 pending 与释放租约。
    await operation?.catch(() => undefined);
    try {
      await journal.flush();
    } finally {
      try {
        if (session) expect(sessionHasPendingWrites(session)).toBe(false);
      } finally {
        try {
          await lease?.release();
        } finally {
          expect(path.dirname(path.resolve(dir))).toBe(root);
          expect(path.basename(dir).startsWith("coremind-session-maintenance-hook-")).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }
});
