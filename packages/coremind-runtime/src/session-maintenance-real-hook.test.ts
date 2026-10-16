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

it("长期租约内真实压缩可反向追加维护事实，保留原始前缀且写入收敛", async () => {
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
    // 13 条约 39k token；默认 20k 保留边界落在 user，避免另走双摘要分支。
    await session.appendMessages(
      Array.from({ length: 13 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text" as const, text: `${index}: ${"old ".repeat(3000)}` }],
        timestamp: index + 1,
      })),
    );
    const prefix = readFileSync(session.filePath);
    const before = await session.branchEntries();
    expect(estimateContextTokens((await session.buildContext()).messages).tokens).toBeGreaterThan(
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    );
    const prep = prepareCompaction(before, DEFAULT_COMPACTION_SETTINGS);
    expect(
      prep.ok && prep.value && !prep.value.isSplitTurn && prep.value.messagesToSummarize.length > 0,
    ).toBe(true);
    const models = createModels();
    const faux = fauxProvider({
      provider: `maintenance-${randomUUID()}`,
      tokensPerSecond: 0,
      models: [{ id: "summary", contextWindow: 30_000, maxTokens: 1024 }],
    });
    models.setProvider(faux.provider);
    faux.setResponses([
      async () => {
        await assertSessionWriteLease(lease!, lease!.sessionPath);
        expect(sessionHasPendingWrites(session!)).toBe(true);
        return fauxAssistantMessage("真实维护摘要");
      },
    ]);
    await journal.start({ configName: "maintenance-hook" });
    operation = compactSessionInRun({
      runId: "maintenance-hook",
      agent: "main",
      session,
      models,
      model: faux.getModel(),
      journal,
      signal: controller.signal,
      emit: () => {},
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
    expect(faux.state.callCount).toBe(1);
    const entries = await session.branchEntries();
    const statuses = entries.flatMap((entry) =>
      entry.type === "custom" && entry.customType === "coremind.session-maintenance.v1"
        ? [(entry.data as { status: string }).status]
        : [],
    );
    expect(statuses).toEqual(["requested", "stop", "compacted"]);
    const compactions = entries.filter((entry) => entry.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]!.summary).toContain("真实维护摘要");
    expect(compactions[0]!.retainedTail.length).toBeGreaterThan(0);
    expect(entries.slice(0, before.length)).toEqual(before);
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    entries.forEach((entry, index) => {
      expect(entry.parentId).toBe(entries[index - 1]?.id ?? null);
    });
    expect(readFileSync(session.filePath).subarray(0, prefix.length)).toEqual(prefix);
    await assertSessionWriteLease(lease, lease.sessionPath);
    expect(await (await CoreMindSession.open(opts)).branchEntries()).toEqual(entries);
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
